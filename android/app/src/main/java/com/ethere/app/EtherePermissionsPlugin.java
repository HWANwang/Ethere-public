package com.ethere.app;

import android.Manifest;
import android.app.AppOpsManager;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.database.Cursor;
import android.graphics.Color;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.provider.OpenableColumns;
import android.net.Uri;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.util.Log;
import android.util.Base64;
import android.view.View;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;
import androidx.activity.result.ActivityResult;

@CapacitorPlugin(
    name = "EtherePermissions",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT })
    }
)
public class EtherePermissionsPlugin extends Plugin {
    private static final String CHANNEL_ID = "ethere_active_messages";
    private ExecutorService notificationStream;
    private ExecutorService usageRequestStream;
    private ExecutorService deviceActionStream;
    private volatile long usageLastPollAt = 0;
    private volatile String usageLastError = "";
    private volatile boolean chatVisible = true;
    private volatile String explicitServerUrl = "";
    private int audioModeBeforeCall = -1;
    private boolean callBarsCaptured = false;
    private int statusBarBeforeCall;
    private int navigationBarBeforeCall;
    private int systemUiBeforeCall;

    @PluginMethod
    public void getCallRingtone(PluginCall call) {
        JSObject result = new JSObject();
        result.put("label", callRingtoneLabel());
        call.resolve(result);
    }

    @PluginMethod
    public void chooseCallRingtone(PluginCall call) {
        if (getActivity() == null) { call.reject("只能在手机上选择铃声"); return; }
        Intent picker = new Intent(RingtoneManager.ACTION_RINGTONE_PICKER);
        picker.putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_RINGTONE);
        picker.putExtra(RingtoneManager.EXTRA_RINGTONE_TITLE, "通话铃声");
        picker.putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, true);
        picker.putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, false);
        String saved = getContext().getSharedPreferences("ethere-call-settings", Context.MODE_PRIVATE).getString("ringtoneUri", "");
        picker.putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, saved.isEmpty() ? Settings.System.DEFAULT_RINGTONE_URI : Uri.parse(saved));
        try { startActivityForResult(call, picker, "callRingtoneChosen"); }
        catch (Exception error) { call.reject("无法打开手机铃声选择器", error); }
    }

    @ActivityCallback
    private void callRingtoneChosen(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            Uri chosen = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                ? result.getData().getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI, Uri.class)
                : result.getData().getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI);
            if (chosen != null) getContext().getSharedPreferences("ethere-call-settings", Context.MODE_PRIVATE)
                .edit().putString("ringtoneUri", chosen.toString()).apply();
        }
        JSObject response = new JSObject();
        response.put("label", callRingtoneLabel());
        call.resolve(response);
    }

    private String callRingtoneLabel() {
        String saved = getContext().getSharedPreferences("ethere-call-settings", Context.MODE_PRIVATE).getString("ringtoneUri", "");
        if (saved.isEmpty() || Settings.System.DEFAULT_RINGTONE_URI.toString().equals(saved)) return "手机默认铃声";
        try {
            Ringtone ringtone = RingtoneManager.getRingtone(getContext(), Uri.parse(saved));
            return ringtone == null ? "手机默认铃声" : ringtone.getTitle(getContext());
        } catch (Exception ignored) { return "手机默认铃声"; }
    }

    @PluginMethod
    public void setChatVisible(PluginCall call) {
        chatVisible = call.getBoolean("visible", true);
        call.resolve();
    }

    @PluginMethod
    public void clearDeliveredNotifications(PluginCall call) {
        // Only Ethere's own notifications are affected. This does not alter chat history.
        NotificationManagerCompat.from(getContext()).cancelAll();
        call.resolve();
    }

    @PluginMethod
    public void consumeOpenChatIntent(PluginCall call) {
        Intent intent = getActivity() == null ? null : getActivity().getIntent();
        boolean openChat = intent != null && intent.getBooleanExtra("ethere_open_chat", false);
        String messageId = openChat ? intent.getStringExtra("ethere_message_id") : null;
        if (openChat) {
            intent.removeExtra("ethere_open_chat");
            intent.removeExtra("ethere_message_id");
        }
        JSObject result = new JSObject();
        result.put("openChat", openChat);
        result.put("messageId", messageId == null ? "" : messageId);
        call.resolve(result);
    }

    @PluginMethod
    public void consumeIncomingCallIntent(PluginCall call) {
        Intent intent = getActivity() == null ? null : getActivity().getIntent();
        boolean answer = intent != null && intent.getBooleanExtra("ethere_answer_call", false);
        String openingText = answer ? intent.getStringExtra("ethere_opening_text") : "";
        if (answer) { intent.removeExtra("ethere_answer_call"); intent.removeExtra("ethere_opening_text"); }
        JSObject result = new JSObject();
        result.put("answer", answer);
        result.put("openingText", openingText == null ? "" : openingText);
        call.resolve(result);
    }

    @PluginMethod
    public void consumeSharedContent(PluginCall call) {
        Intent intent = getActivity() == null ? null : getActivity().getIntent();
        String action = intent == null ? "" : intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            JSObject empty = new JSObject();
            empty.put("text", "");
            empty.put("files", new JSONArray());
            call.resolve(empty);
            return;
        }

        // Claim the intent before the background read, so resume/reload cannot duplicate a draft.
        intent.setAction(Intent.ACTION_MAIN);
        execute(() -> {
            try {
                String sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
                JSONArray files = new JSONArray();
                ArrayList<Uri> uris = new ArrayList<>();
                if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
                    ArrayList<Uri> multiple = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                    if (multiple != null) uris.addAll(multiple);
                } else {
                    Uri single = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                    if (single != null) uris.add(single);
                }
                if (uris.isEmpty() && intent.getClipData() != null) {
                    for (int index = 0; index < intent.getClipData().getItemCount(); index += 1) {
                        Uri uri = intent.getClipData().getItemAt(index).getUri();
                        if (uri != null) uris.add(uri);
                    }
                }
                if (uris.size() > 7) throw new IllegalArgumentException("一次最多分享 4 张图片和 3 个文件");
                int totalBytes = 0;
                for (Uri uri : uris) {
                    String name = sharedFileName(uri);
                    String mime = getContext().getContentResolver().getType(uri);
                    if (mime == null || mime.isEmpty()) mime = "application/octet-stream";
                    boolean image = mime.startsWith("image/") || name.matches("(?i).*\\.(png|jpe?g|webp|gif|heic)$");
                    if (!image && !name.matches("(?i).*\\.(pdf|docx|txt|md)$")) {
                        throw new IllegalArgumentException("Ethere 暂不支持这个文件格式：" + name);
                    }
                    int limit = image ? 12 * 1024 * 1024 : 8 * 1024 * 1024;
                    byte[] data = readSharedFile(uri, limit);
                    totalBytes += data.length;
                    if (totalBytes > 32 * 1024 * 1024) throw new IllegalArgumentException("分享的附件总量不能超过 32 MB");
                    JSONObject file = new JSONObject();
                    file.put("name", name);
                    file.put("mime", mime);
                    file.put("image", image);
                    file.put("dataUrl", "data:" + mime + ";base64," + Base64.encodeToString(data, Base64.NO_WRAP));
                    files.put(file);
                }
                JSObject result = new JSObject();
                result.put("text", sharedText == null ? "" : sharedText);
                result.put("files", files);
                call.resolve(result);
            } catch (Exception error) {
                Log.w("EthereShare", "无法读取分享内容", error);
                call.reject(error.getMessage() == null ? "无法读取分享内容" : error.getMessage(), error);
            }
        });
    }

    private String sharedFileName(Uri uri) {
        String name = null;
        try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
        } catch (Exception ignored) { /* URI path remains a fallback. */ }
        if (name == null || name.trim().isEmpty()) name = uri.getLastPathSegment();
        return name == null || name.trim().isEmpty() ? "shared-file" : name;
    }

    private byte[] readSharedFile(Uri uri, int limit) throws Exception {
        try (InputStream input = getContext().getContentResolver().openInputStream(uri);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input == null) throw new IllegalArgumentException("分享的文件无法读取");
            byte[] buffer = new byte[16 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > limit) throw new IllegalArgumentException("分享的文件太大，请在 Ethere 内单独选择");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    @PluginMethod
    public void getPermissionStatus(PluginCall call) {
        String kind = call.getString("kind", "");
        JSObject result = new JSObject();
        if ("usage".equals(kind)) result.put("status", hasUsageAccess() ? "granted" : "denied");
        else if ("notifications".equals(kind)) result.put("status", notificationStatus());
        else if ("background".equals(kind)) result.put("status", hasBackgroundAccess() ? "granted" : "denied");
        else if ("overlay".equals(kind)) result.put("status", Settings.canDrawOverlays(getContext()) ? "granted" : "denied");
        else if ("microphone".equals(kind)) result.put("status", getPermissionState("microphone") == PermissionState.GRANTED ? "granted" : "denied");
        else if ("exactAlarm".equals(kind)) result.put("status", canScheduleExactAlarm() ? "granted" : "denied");
        else if ("fullScreenCall".equals(kind)) result.put("status", canUseFullScreenCall() ? "granted" : "denied");
        else result.put("status", "unavailable");
        call.resolve(result);
    }

    @PluginMethod
    public void requestUsageAccess(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject result = new JSObject();
            result.put("status", hasUsageAccess() ? "granted" : "denied");
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法打开使用情况访问设置", error);
        }
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        ensureNotificationChannel();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            JSObject result = new JSObject();
            result.put("status", notificationStatus());
            call.resolve(result);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
    }

    @PluginMethod
    public void requestBackgroundAccess(PluginCall call) {
        try {
            if (!hasBackgroundAccess()) {
                Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                getContext().startActivity(intent);
            }
            JSObject result = new JSObject();
            result.put("status", hasBackgroundAccess() ? "granted" : "denied");
            call.resolve(result);
        } catch (Exception error) {
            Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
            getContext().startActivity(fallback);
            JSObject result = new JSObject();
            result.put("status", hasBackgroundAccess() ? "granted" : "denied");
            call.resolve(result);
        }
    }

    @PluginMethod
    public void requestOverlayAccess(PluginCall call) {
        if (!Settings.canDrawOverlays(getContext())) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
        JSObject result = new JSObject();
        result.put("status", Settings.canDrawOverlays(getContext()) ? "granted" : "denied");
        call.resolve(result);
    }

    @PluginMethod
    public void requestMicrophonePermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("status", "granted");
            call.resolve(result);
            return;
        }
        requestPermissionForAlias("microphone", call, "microphonePermissionCallback");
    }

    @PluginMethod
    public void requestExactAlarmAccess(PluginCall call) {
        if (!canScheduleExactAlarm() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
        JSObject result = new JSObject();
        result.put("status", canScheduleExactAlarm() ? "granted" : "denied");
        call.resolve(result);
    }

    @PluginMethod
    public void requestFullScreenCallAccess(PluginCall call) {
        if (!canUseFullScreenCall() && Build.VERSION.SDK_INT >= 34) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
        JSObject result = new JSObject();
        result.put("status", canUseFullScreenCall() ? "granted" : "denied");
        call.resolve(result);
    }

    @PermissionCallback
    private void microphonePermissionCallback(PluginCall call) {
        JSObject result = new JSObject();
        result.put("status", getPermissionState("microphone") == PermissionState.GRANTED ? "granted" : "denied");
        call.resolve(result);
    }

    @PluginMethod
    public void updateAssistantName(PluginCall call) {
        String name = call.getString("name", "");
        if (name == null || name.trim().isEmpty() || name.trim().length() > 20) { call.reject("助手名称无效"); return; }
        EthereIncomingCallManager.updateCallerName(getContext(), name.trim());
        call.resolve();
    }

    @PluginMethod
    public void startCallForeground(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) { call.reject("麦克风权限未开启"); return; }
        try {
            Intent service = new Intent(getContext(), EthereCallForegroundService.class);
            String assistantName = call.getString("name", "Ethere");
            service.putExtra("assistant_name", assistantName == null || assistantName.trim().isEmpty() ? "Ethere" : assistantName.trim());
            ContextCompat.startForegroundService(getContext(), service);
            if (getActivity() != null) getActivity().runOnUiThread(() -> {
                if (!callBarsCaptured) {
                    statusBarBeforeCall = getActivity().getWindow().getStatusBarColor();
                    navigationBarBeforeCall = getActivity().getWindow().getNavigationBarColor();
                    systemUiBeforeCall = getActivity().getWindow().getDecorView().getSystemUiVisibility();
                    callBarsCaptured = true;
                }
                getActivity().getWindow().setStatusBarColor(Color.rgb(15, 17, 23));
                getActivity().getWindow().setNavigationBarColor(Color.rgb(15, 17, 23));
                getActivity().getWindow().getDecorView().setSystemUiVisibility(systemUiBeforeCall & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
            });
            call.resolve();
        } catch (Exception error) { call.reject("无法保持语音通话在后台运行", error); }
    }

    @PluginMethod
    public void listAudioOutputs(PluginCall call) {
        AudioManager manager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (manager == null) { call.reject("手机音频服务不可用"); return; }
        JSONArray devices = new JSONArray();
        int selectedId = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo selected = manager.getCommunicationDevice();
            if (selected != null) selectedId = selected.getId();
            for (AudioDeviceInfo device : manager.getAvailableCommunicationDevices()) {
                String label = audioOutputLabel(device.getType());
                if (label.isEmpty()) continue;
                JSONObject item = new JSONObject();
                try { item.put("id", device.getId()); item.put("label", label); devices.put(item); }
                catch (Exception ignored) { /* Keep the other available routes. */ }
            }
        } else {
            try {
                devices.put(new JSONObject().put("id", -1).put("label", "听筒"));
                devices.put(new JSONObject().put("id", -2).put("label", "扬声器"));
            } catch (Exception ignored) { }
            selectedId = manager.isSpeakerphoneOn() ? -2 : -1;
        }
        JSObject result = new JSObject();
        result.put("devices", devices);
        result.put("selectedId", selectedId);
        call.resolve(result);
    }

    @PluginMethod
    public void selectAudioOutput(PluginCall call) {
        Integer id = call.getInt("id");
        if (id == null) { call.reject("请选择音频设备"); return; }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioManager manager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (manager == null) { call.reject("手机音频服务不可用"); return; }
            for (AudioDeviceInfo device : manager.getAvailableCommunicationDevices()) {
                if (device.getId() != id) continue;
                if (isBluetoothOutput(device.getType()) && getPermissionState("bluetooth") != PermissionState.GRANTED) {
                    requestPermissionForAlias("bluetooth", call, "bluetoothOutputPermissionCallback");
                    return;
                }
                applyAudioOutput(call);
                return;
            }
            call.reject("该音频设备已断开，请重新选择");
        } else applyAudioOutput(call);
    }

    @PermissionCallback
    private void bluetoothOutputPermissionCallback(PluginCall call) {
        if (getPermissionState("bluetooth") == PermissionState.GRANTED) applyAudioOutput(call);
        else call.reject("需要蓝牙连接权限才能切换到耳机");
    }

    private void applyAudioOutput(PluginCall call) {
        AudioManager manager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (manager == null) { call.reject("手机音频服务不可用"); return; }
        Integer id = call.getInt("id");
        if (id == null) { call.reject("请选择音频设备"); return; }
        if (audioModeBeforeCall < 0) audioModeBeforeCall = manager.getMode();
        manager.setMode(AudioManager.MODE_IN_COMMUNICATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            for (AudioDeviceInfo device : manager.getAvailableCommunicationDevices()) {
                if (device.getId() == id) {
                    if (!manager.setCommunicationDevice(device)) { call.reject("音频切换失败，请重试"); return; }
                    JSObject result = new JSObject(); result.put("selectedId", id); call.resolve(result); return;
                }
            }
            call.reject("该音频设备已断开，请重新选择");
        } else {
            manager.setSpeakerphoneOn(id == -2);
            JSObject result = new JSObject(); result.put("selectedId", id); call.resolve(result);
        }
    }

    private static boolean isBluetoothOutput(int type) {
        return type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || type == AudioDeviceInfo.TYPE_BLE_HEADSET
            || type == AudioDeviceInfo.TYPE_BLE_SPEAKER || type == AudioDeviceInfo.TYPE_HEARING_AID;
    }

    private static String audioOutputLabel(int type) {
        if (type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) return "听筒";
        if (type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) return "扬声器";
        if (isBluetoothOutput(type)) return "蓝牙设备";
        if (type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || type == AudioDeviceInfo.TYPE_WIRED_HEADSET || type == AudioDeviceInfo.TYPE_USB_HEADSET) return "有线耳机";
        return "";
    }

    @PluginMethod
    public void stopCallForeground(PluginCall call) {
        if (getActivity() != null) getActivity().runOnUiThread(() -> {
            if (callBarsCaptured) {
                getActivity().getWindow().setStatusBarColor(statusBarBeforeCall);
                getActivity().getWindow().setNavigationBarColor(navigationBarBeforeCall);
                getActivity().getWindow().getDecorView().setSystemUiVisibility(systemUiBeforeCall);
                callBarsCaptured = false;
            }
        });
        AudioManager manager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (manager != null && audioModeBeforeCall >= 0) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) manager.clearCommunicationDevice();
            else manager.setSpeakerphoneOn(false);
            manager.setMode(audioModeBeforeCall);
            audioModeBeforeCall = -1;
        }
        getContext().stopService(new Intent(getContext(), EthereCallForegroundService.class));
        call.resolve();
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        JSObject result = new JSObject();
        result.put("status", notificationStatus());
        call.resolve(result);
    }

    @PluginMethod
    public void collectUsageSnapshot(PluginCall call) {
        if (!hasUsageAccess()) {
            call.reject("尚未授予应用使用情况访问权限");
            return;
        }
        try {
            call.resolve(PhoneUsageCollector.collect(getContext(), call.getInt("lookbackMinutes", 120), ""));
        } catch (Exception error) {
            call.reject("读取手机使用情况失败", error);
        }
    }

    @PluginMethod
    public void showNotification(PluginCall call) {
        if (!"granted".equals(notificationStatus())) {
            call.reject("通知权限未开启");
            return;
        }
        ensureNotificationChannel();
        String title = call.getString("title", "Ethere");
        String body = call.getString("body", "");
        int id = call.getInt("id", (int) (System.currentTimeMillis() & 0x7fffffff));
        int eventCursor = call.getInt("eventCursor", 0);
        String messageId = call.getString("messageId", "");
        if (eventCursor > 0) showEventNotification(eventCursor, title, body, messageId);
        else showNotificationInternal(id, title, body, messageId);
        call.resolve();
    }

    @PluginMethod
    public void startNotificationStream(PluginCall call) {
        String requestedServerUrl = call.getString("serverUrl", "");
        if (requestedServerUrl != null && (requestedServerUrl.startsWith("https://") || requestedServerUrl.startsWith("http://127.0.0.1:") || requestedServerUrl.startsWith("http://localhost:"))) {
            explicitServerUrl = requestedServerUrl.replaceAll("/+$", "");
        }
        int requestedCursor = call.getInt("after", 0);
        rememberNotificationCursor(requestedCursor);
        if (notificationStream == null || notificationStream.isShutdown()) {
            notificationStream = Executors.newSingleThreadExecutor();
            notificationStream.submit(this::runNotificationStream);
        }
        if (usageRequestStream == null || usageRequestStream.isShutdown()) {
            usageRequestStream = Executors.newSingleThreadExecutor();
            Log.i("EthereUsage", "实时采集通道启动，目标：" + serverBaseUrl());
            usageRequestStream.submit(this::runUsageRequestStream);
        }
        if (deviceActionStream == null || deviceActionStream.isShutdown()) {
            deviceActionStream = Executors.newSingleThreadExecutor();
            deviceActionStream.submit(this::runDeviceActionStream);
        }
        call.resolve();
    }

    private void runDeviceActionStream() {
        while (!Thread.currentThread().isInterrupted()) {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(serverBaseUrl() + "/api/ethere/v1/device-actions/poll").openConnection();
                connection.setRequestProperty("Accept", "application/json");
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(20000);
                if (connection.getResponseCode() != 200) throw new IllegalStateException("设备动作 HTTP " + connection.getResponseCode());
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                    JSONObject payload = new JSONObject(reader.readLine());
                    JSONObject action = payload.optJSONObject("action");
                    if (action != null) handleDeviceAction(action);
                }
            } catch (Exception error) {
                Log.w("EthereDeviceAction", "设备动作通道重连：" + error.getMessage());
            } finally {
                if (connection != null) connection.disconnect();
            }
            try { Thread.sleep(1000); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        }
    }

    private void handleDeviceAction(JSONObject action) throws Exception {
        String id = action.optString("id", "");
        if (id.isEmpty()) return;
        String endpoint = serverBaseUrl() + "/api/ethere/v1/device-actions/" + id;
        if ("incoming_call_cancel".equals(action.optString("type"))) {
            EthereIncomingCallManager.cancel(getContext(), action.optString("targetId", ""));
            JSONObject result = new JSONObject();
            result.put("outcome", "cancelled");
            postJson(endpoint + "/result", result.toString());
        } else if ("attention_popup".equals(action.optString("type"))) {
            if (!Settings.canDrawOverlays(getContext())) {
                JSONObject result = new JSONObject();
                result.put("outcome", "failed");
                result.put("error", "悬浮窗权限未开启");
                postJson(endpoint + "/result", result.toString());
                return;
            }
            new Handler(Looper.getMainLooper()).post(() -> {
                boolean shown = EthereAttentionOverlay.show(getContext(), action, outcome -> execute(() -> {
                    try {
                        JSONObject result = new JSONObject();
                        result.put("outcome", outcome);
                        postJson(endpoint + "/result", result.toString());
                    } catch (Exception error) { Log.w("EthereDeviceAction", "弹窗结果回传失败", error); }
                }));
                execute(() -> {
                    try {
                        JSONObject payload = new JSONObject();
                        if (shown) {
                            payload.put("state", "displaying");
                            postJson(endpoint + "/ack", payload.toString());
                        } else {
                            payload.put("outcome", "failed");
                            payload.put("error", "无法显示悬浮窗");
                            postJson(endpoint + "/result", payload.toString());
                        }
                    } catch (Exception error) { Log.w("EthereDeviceAction", "弹窗确认回传失败", error); }
                });
            });
        } else if ("incoming_call".equals(action.optString("type"))) {
            try {
                EthereIncomingCallManager.schedule(getContext(), action, serverBaseUrl());
                JSONObject ack = new JSONObject();
                ack.put("state", java.time.Instant.parse(action.optString("triggerAt")).toEpochMilli() > System.currentTimeMillis() + 1500 ? "scheduled" : "displaying");
                postJson(endpoint + "/ack", ack.toString());
            } catch (Exception error) {
                JSONObject result = new JSONObject();
                result.put("outcome", "failed");
                result.put("error", error.getMessage() == null ? "无法安排来电" : error.getMessage());
                postJson(endpoint + "/result", result.toString());
            }
        }
    }

    @PluginMethod
    public void getUsageChannelStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("running", usageRequestStream != null && !usageRequestStream.isShutdown());
        result.put("lastPollAt", usageLastPollAt);
        result.put("lastError", usageLastError);
        call.resolve(result);
    }

    @PluginMethod
    public void startNotificationPolling(PluginCall call) {
        startNotificationStream(call);
    }

    private void showNotificationInternal(int id, String title, String body, String messageId) {
        ensureNotificationChannel();
        Intent open = new Intent(getContext(), MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        open.putExtra("ethere_open_chat", true);
        open.putExtra("ethere_message_id", messageId == null ? "" : messageId);
        PendingIntent pending = PendingIntent.getActivity(getContext(), id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pending);
        NotificationManagerCompat.from(getContext()).notify(id, builder.build());
    }

    private void runNotificationStream() {
        while (!Thread.currentThread().isInterrupted()) {
            HttpURLConnection connection = null;
            try {
                int cursor = getContext().getSharedPreferences("ethere-native", Context.MODE_PRIVATE).getInt("notificationCursor", 0);
                String baseUrl = serverBaseUrl();
                connection = (HttpURLConnection) new URL(baseUrl + "/api/ethere/v1/chat/events/stream?after=" + cursor).openConnection();
                connection.setRequestProperty("Accept", "text/event-stream");
                connection.setRequestProperty("Cache-Control", "no-cache");
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(70000);
                if (connection.getResponseCode() != 200) throw new IllegalStateException("SSE HTTP " + connection.getResponseCode());
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream()))) {
                    String line;
                    while (!Thread.currentThread().isInterrupted() && (line = reader.readLine()) != null) {
                        if (line.startsWith("data:")) handleNotificationBatch(line.substring(5).trim());
                    }
                }
            } catch (Exception ignored) {
                // 电脑关机、网络切换或系统暂停后台时会断线；稍后按游标重连补齐。
            } finally {
                if (connection != null) connection.disconnect();
            }
            try { Thread.sleep(3000); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        }
    }

    private void runUsageRequestStream() {
        while (!Thread.currentThread().isInterrupted()) {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(serverBaseUrl() + "/api/ethere/v1/phone-usage/requests/poll").openConnection();
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("Cache-Control", "no-cache");
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(25000);
                if (connection.getResponseCode() != 200) throw new IllegalStateException("采集请求 HTTP " + connection.getResponseCode());
                usageLastPollAt = System.currentTimeMillis();
                usageLastError = "";
                Log.d("EthereUsage", "实时采集轮询已连接");
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                    String line = reader.readLine();
                    if (line != null) {
                        JSONObject payload = new JSONObject(line);
                        JSONObject request = payload.optJSONObject("request");
                        if (request != null) handleUsageRequest(request.toString());
                    }
                }
            } catch (Exception error) {
                String message = error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage());
                if (!message.equals(usageLastError)) Log.w("EthereUsage", "实时采集轮询失败：" + message);
                usageLastError = message;
            } finally {
                if (connection != null) connection.disconnect();
            }
            try { Thread.sleep(1000); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        }
    }

    private void handleUsageRequest(String json) {
        String id = "";
        try {
            JSONObject request = new JSONObject(json);
            id = request.optString("id", "");
            if (id.isEmpty()) return;
            if (!hasUsageAccess()) throw new IllegalStateException("手机使用情况访问权限未开启");
            JSObject snapshot = PhoneUsageCollector.collect(getContext(), request.optInt("lookbackMinutes", 120), id);
            postJson(serverBaseUrl() + "/api/ethere/v1/phone-usage/snapshots", snapshot.toString());
            Log.i("EthereUsage", "实时采集请求完成");
        } catch (Exception error) {
            Log.w("EthereUsage", "实时采集请求失败：" + error.getMessage());
            if (!id.isEmpty()) {
                try {
                    JSONObject failure = new JSONObject();
                    failure.put("error", error.getMessage() == null ? "手机采集失败" : error.getMessage());
                    postJson(serverBaseUrl() + "/api/ethere/v1/phone-usage/requests/" + id + "/fail", failure.toString());
                } catch (Exception ignored) { /* The server's timeout still reports the failure. */ }
            }
        }
    }

    private void postJson(String url, String body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.setDoOutput(true);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.getBytes(StandardCharsets.UTF_8));
            }
            if (connection.getResponseCode() < 200 || connection.getResponseCode() >= 300) {
                throw new IllegalStateException("手机数据上传失败：HTTP " + connection.getResponseCode());
            }
        } finally {
            connection.disconnect();
        }
    }

    private String serverBaseUrl() {
        String baseUrl = explicitServerUrl.isEmpty() ? getBridge().getServerUrl() : explicitServerUrl;
        if (baseUrl == null || baseUrl.trim().isEmpty()) baseUrl = "http://127.0.0.1:4173";
        return baseUrl.replaceAll("/+$", "");
    }

    private void handleNotificationBatch(String json) {
        try {
            JSONObject payload = new JSONObject(json);
            if (payload.optBoolean("reset", false)) {
                setNotificationCursor(payload.optInt("cursor", 0));
                return;
            }
            JSONArray events = payload.optJSONArray("events");
            if (events != null) for (int index = 0; index < events.length(); index += 1) {
                JSONObject event = events.optJSONObject(index);
                if (event == null) continue;
                int seq = event.optInt("seq", 0);
                String role = event.optString("role");
                String source = event.optString("source");
                boolean memoryNotice = "notice".equals(role) && "memory".equals(source);
                boolean proactive = "checkin".equals(source) || "reminder".equals(source) || "space".equals(source);
                boolean completedChatTurn = "chat".equals(source) && event.optBoolean("turnComplete", false);
                if ((("assistant".equals(role) && (proactive || completedChatTurn)) || memoryNotice)
                    && !EthereCallForegroundService.isRunning() && !MainActivity.isEthereForeground() && "granted".equals(notificationStatus())) {
                    String title = memoryNotice ? "记忆已更新" : "space".equals(source) ? "空间有了新回复" : "reminder".equals(source) ? "提醒" : "Ethere";
                    showEventNotification(seq, title, event.optString("content"), event.optString("id"));
                }
                rememberNotificationCursor(seq);
            }
            rememberNotificationCursor(payload.optInt("cursor", 0));
        } catch (Exception ignored) { /* 下一条有效事件仍可继续处理。 */ }
    }

    private void rememberNotificationCursor(int cursor) {
        if (cursor <= 0) return;
        int current = getContext().getSharedPreferences("ethere-native", Context.MODE_PRIVATE).getInt("notificationCursor", 0);
        if (cursor > current) getContext().getSharedPreferences("ethere-native", Context.MODE_PRIVATE).edit().putInt("notificationCursor", cursor).apply();
    }

    private void setNotificationCursor(int cursor) {
        getContext().getSharedPreferences("ethere-native", Context.MODE_PRIVATE).edit().putInt("notificationCursor", Math.max(0, cursor)).apply();
    }

    private synchronized void showEventNotification(int cursor, String title, String body, String messageId) {
        if (cursor <= 0) return;
        if (MainActivity.isEthereForeground() || EthereCallForegroundService.isRunning()) return;
        int displayed = getContext().getSharedPreferences("ethere-native", Context.MODE_PRIVATE).getInt("notificationDisplayedCursor", 0);
        if (cursor <= displayed) return;
        showNotificationInternal(cursor, title, body, messageId);
        getContext().getSharedPreferences("ethere-native", Context.MODE_PRIVATE).edit().putInt("notificationDisplayedCursor", cursor).apply();
    }

    @Override
    protected void handleOnDestroy() {
        if (notificationStream != null) notificationStream.shutdownNow();
        if (usageRequestStream != null) usageRequestStream.shutdownNow();
        if (deviceActionStream != null) deviceActionStream.shutdownNow();
        notificationStream = null;
        usageRequestStream = null;
        deviceActionStream = null;
        super.handleOnDestroy();
    }

    private boolean hasUsageAccess() {
        AppOpsManager appOps = (AppOpsManager) getContext().getSystemService(Context.APP_OPS_SERVICE);
        if (appOps == null) return false;
        int mode = appOps.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), getContext().getPackageName());
        return mode == AppOpsManager.MODE_ALLOWED;
    }

    private String notificationStatus() {
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) return "denied";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) return "denied";
        return "granted";
    }

    private boolean hasBackgroundAccess() {
        PowerManager manager = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return manager != null && manager.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    private boolean canScheduleExactAlarm() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager manager = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        return manager != null && manager.canScheduleExactAlarms();
    }

    private boolean canUseFullScreenCall() {
        if (Build.VERSION.SDK_INT < 34) return true;
        NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        return manager != null && manager.canUseFullScreenIntent();
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "主动消息与提醒", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("空间回复、主动联系与提醒任务");
        manager.createNotificationChannel(channel);
    }

}
