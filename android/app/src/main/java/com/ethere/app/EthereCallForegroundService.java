package com.ethere.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

public class EthereCallForegroundService extends Service {
    private static final String CHANNEL_ID = "ethere_voice_call";
    private static final int NOTIFICATION_ID = 950012;
    private static volatile boolean running = false;

    public static boolean isRunning() { return running; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannel();
        String callerName = intent == null ? "" : intent.getStringExtra("assistant_name");
        if (callerName == null || callerName.trim().isEmpty()) callerName = "Ethere";
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(callerName + " 语音通话中")
            .setContentText("正在聆听；轻点返回通话")
            .setContentIntent(pending)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        else startForeground(NOTIFICATION_ID, notification);
        running = true;
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() { running = false; super.onDestroy(); }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "语音通话", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("仅在 Ethere 语音通话期间显示");
        manager.createNotificationChannel(channel);
    }
}
