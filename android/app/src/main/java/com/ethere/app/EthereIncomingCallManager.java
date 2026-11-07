package com.ethere.app;

import android.Manifest;
import android.app.AlarmManager;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.media.AudioAttributes;
import android.os.VibrationAttributes;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.json.JSONObject;

final class EthereIncomingCallManager {
    static final String ACTION_ALARM = "com.ethere.app.INCOMING_CALL_ALARM";
    private static final String CHANNEL_ID = "ethere_incoming_calls";
    private static final String STORE = "ethere-scheduled-calls";
    private static Ringtone currentRingtone;
    private static Vibrator currentVibrator;
    private static String ringingId = "";

    static void schedule(Context context, JSONObject action, String serverBaseUrl) throws Exception {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()
            || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)) {
            throw new IllegalStateException("通知权限未开启，无法发起来电");
        }
        String id = action.optString("id", "");
        if (id.isEmpty()) throw new IllegalArgumentException("来电 ID 缺失");
        long at = java.time.Instant.parse(action.optString("triggerAt")).toEpochMilli();
        JSONObject saved = new JSONObject(action.toString());
        saved.put("serverBaseUrl", serverBaseUrl);
        if (at > System.currentTimeMillis() + 1500) {
            AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (alarms == null) throw new IllegalStateException("手机闹钟服务不可用");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarms.canScheduleExactAlarms()) throw new SecurityException("精确闹钟权限未开启，无法保证准点来电");
            PendingIntent pending = alarmIntent(context, id);
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
            context.getSharedPreferences(STORE, Context.MODE_PRIVATE).edit().putString("call:" + id, saved.toString()).apply();
        } else {
            context.getSharedPreferences(STORE, Context.MODE_PRIVATE).edit().putString("call:" + id, saved.toString()).apply();
            showIncoming(context, id);
        }
    }

    static void rescheduleAfterBoot(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(STORE, Context.MODE_PRIVATE);
        for (Map.Entry<String, ?> entry : preferences.getAll().entrySet()) {
            if (!entry.getKey().startsWith("call:") || !(entry.getValue() instanceof String)) continue;
            try {
                JSONObject action = new JSONObject((String) entry.getValue());
                long at = java.time.Instant.parse(action.optString("triggerAt")).toEpochMilli();
                if (at < System.currentTimeMillis() - 60000) { preferences.edit().remove(entry.getKey()).apply(); continue; }
                schedule(context, action, action.optString("serverBaseUrl"));
            } catch (Exception ignored) { /* Invalid or unauthorized alarm remains visible through the server's status. */ }
        }
    }

    static JSONObject get(Context context, String id) {
        String value = context.getSharedPreferences(STORE, Context.MODE_PRIVATE).getString("call:" + id, "");
        try { return value.isEmpty() ? null : new JSONObject(value); } catch (Exception error) { return null; }
    }

    static void updateCallerName(Context context, String name) {
        SharedPreferences preferences = context.getSharedPreferences(STORE, Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = preferences.edit();
        for (Map.Entry<String, ?> entry : preferences.getAll().entrySet()) {
            if (!entry.getKey().startsWith("call:") || !(entry.getValue() instanceof String)) continue;
            try {
                JSONObject action = new JSONObject((String) entry.getValue());
                action.put("title", name);
                editor.putString(entry.getKey(), action.toString());
            } catch (Exception ignored) { /* An invalid saved call must not block renaming. */ }
        }
        editor.apply();
    }

    static void showIncoming(Context context, String id) {
        JSONObject action = get(context, id);
        if (action == null) return;
        ensureChannel(context);
        startAlert(context, id);
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        KeyguardManager keyguard = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        if (Settings.canDrawOverlays(context) && power != null && power.isInteractive() && (keyguard == null || !keyguard.isKeyguardLocked())) {
            new Handler(Looper.getMainLooper()).post(() -> {
                if (get(context, id) != null && !EthereIncomingCallOverlay.show(context, action)) postCallNotification(context, action);
            });
        } else postCallNotification(context, action);
    }

    private static void postCallNotification(Context context, JSONObject action) {
        String id = action.optString("id", "");
        if (id.isEmpty() || get(context, id) == null) return;
        Intent open = new Intent(context, EthereIncomingCallActivity.class);
        open.putExtra("ethere_call_id", id);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(context, id.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(action.optString("title", "Ethere"))
            .setContentText("语音来电 · 点击接听或稍后提醒")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setAutoCancel(false)
            .setOngoing(true)
            .setContentIntent(pending)
            .setFullScreenIntent(pending, true)
            .build();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            NotificationManagerCompat.from(context).notify(id.hashCode(), notification);
        }
    }

    static void snooze(Context context, String id) throws Exception {
        JSONObject action = get(context, id);
        if (action == null) throw new IllegalArgumentException("来电已不存在");
        int minutes = action.optInt("snoozeMinutes", 10);
        if (minutes < 1 || minutes > 1440) minutes = 10;
        action.put("triggerAt", java.time.Instant.ofEpochMilli(System.currentTimeMillis() + minutes * 60000L).toString());
        schedule(context, action, action.optString("serverBaseUrl"));
        postResultAsync(context, action, "snoozed", "");
        NotificationManagerCompat.from(context).cancel(id.hashCode());
        stopAlert(id);
        new Handler(Looper.getMainLooper()).post(() -> EthereIncomingCallOverlay.dismiss(id));
    }

    static void finish(Context context, String id, String outcome) {
        JSONObject action = get(context, id);
        if (action == null) return;
        cancel(context, id);
        postResultAsync(context, action, outcome, "");
    }

    static void cancel(Context context, String id) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms != null) alarms.cancel(alarmIntent(context, id));
        context.getSharedPreferences(STORE, Context.MODE_PRIVATE).edit().remove("call:" + id).apply();
        NotificationManagerCompat.from(context).cancel(id.hashCode());
        stopAlert(id);
        new Handler(Looper.getMainLooper()).post(() -> EthereIncomingCallOverlay.dismiss(id));
    }

    private static PendingIntent alarmIntent(Context context, String id) {
        Intent intent = new Intent(context, EthereIncomingCallReceiver.class);
        intent.setAction(ACTION_ALARM);
        intent.putExtra("ethere_call_id", id);
        return PendingIntent.getBroadcast(context, id.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Ethere 来电", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Ethere 主动来电式提醒");
        channel.enableVibration(true);
        channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), null);
        manager.createNotificationChannel(channel);
    }

    private static synchronized void startAlert(Context context, String id) {
        if (id.equals(ringingId)) return;
        stopAlert(ringingId);
        ringingId = id;
        try {
            String selectedUri = context.getSharedPreferences("ethere-call-settings", Context.MODE_PRIVATE).getString("ringtoneUri", "");
            android.net.Uri ringtoneUri = selectedUri.isEmpty() ? RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE) : android.net.Uri.parse(selectedUri);
            currentRingtone = RingtoneManager.getRingtone(context, ringtoneUri);
            if (currentRingtone != null) {
                currentRingtone.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) currentRingtone.setLooping(true);
                currentRingtone.play();
            }
        } catch (Exception ignored) { currentRingtone = null; }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager manager = (VibratorManager) context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                currentVibrator = manager == null ? null : manager.getDefaultVibrator();
            } else currentVibrator = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
            if (currentVibrator != null && currentVibrator.hasVibrator()) {
                VibrationEffect pattern = VibrationEffect.createWaveform(new long[] { 0, 550, 800 }, 0);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                    currentVibrator.vibrate(pattern, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM));
                else currentVibrator.vibrate(pattern, new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build());
            }
        } catch (Exception ignored) { currentVibrator = null; }
    }

    private static synchronized void stopAlert(String id) {
        if (!ringingId.equals(id)) return;
        if (currentRingtone != null) try { currentRingtone.stop(); } catch (Exception ignored) { }
        if (currentVibrator != null) currentVibrator.cancel();
        currentRingtone = null;
        currentVibrator = null;
        ringingId = "";
    }

    static void stopRinging(String id) { stopAlert(id); }

    private static void postResultAsync(Context context, JSONObject action, String outcome, String error) {
        String id = action.optString("id", "");
        String baseUrl = action.optString("serverBaseUrl", "");
        if (id.isEmpty() || baseUrl.isEmpty()) return;
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                JSONObject payload = new JSONObject();
                payload.put("outcome", outcome);
                payload.put("error", error);
                if ("snoozed".equals(outcome)) payload.put("triggerAt", action.optString("triggerAt", ""));
                connection = (HttpURLConnection) new URL(baseUrl + "/api/ethere/v1/device-actions/" + id + "/result").openConnection();
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setConnectTimeout(5000);
                connection.setReadTimeout(5000);
                connection.setDoOutput(true);
                try (OutputStream output = connection.getOutputStream()) { output.write(payload.toString().getBytes(StandardCharsets.UTF_8)); }
                connection.getResponseCode();
            } catch (Exception ignored) { /* Native outcome remains local if the computer is offline. */ }
            finally { if (connection != null) connection.disconnect(); }
        }, "ethere-call-result").start();
    }
}
