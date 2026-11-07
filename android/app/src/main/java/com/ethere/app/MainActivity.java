package com.ethere.app;

import android.content.Intent;
import android.app.NotificationManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.app.NotificationManagerCompat;
import android.service.notification.StatusBarNotification;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    private static volatile boolean ethereForeground;

    public static boolean isEthereForeground() {
        return ethereForeground;
    }

    @Override
    public void onResume() {
        super.onResume();
        ethereForeground = true;
        // Launching from the icon or returning from another app counts as viewing Ethere.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager != null) for (StatusBarNotification entry : manager.getActiveNotifications()) {
                String channel = entry.getNotification().getChannelId();
                if ("ethere_incoming_calls".equals(channel) || "ethere_voice_call".equals(channel)) continue;
                manager.cancel(entry.getTag(), entry.getId());
            }
        } else if (!EthereCallForegroundService.isRunning()) {
            NotificationManagerCompat.from(this).cancelAll();
        }
    }

    @Override
    public void onPause() {
        ethereForeground = false;
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if ((Intent.ACTION_SEND.equals(intent.getAction()) || Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction()))
            && getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().evaluateJavascript(
                "window.EthereHandleSharedContent && window.EthereHandleSharedContent()", null
            );
        }
        if (intent.getBooleanExtra("ethere_open_chat", false) && getBridge() != null && getBridge().getWebView() != null) {
            String messageId = intent.getStringExtra("ethere_message_id");
            getBridge().getWebView().evaluateJavascript(
                "window.EthereOpenChatFromNotification && window.EthereOpenChatFromNotification(" + JSONObject.quote(messageId == null ? "" : messageId) + ")", null
            );
        }
        if (intent.getBooleanExtra("ethere_answer_call", false) && getBridge() != null && getBridge().getWebView() != null) {
            String openingText = intent.getStringExtra("ethere_opening_text");
            intent.removeExtra("ethere_answer_call");
            intent.removeExtra("ethere_opening_text");
            getBridge().getWebView().evaluateJavascript("window.EthereAnswerIncomingCall && window.EthereAnswerIncomingCall(" + JSONObject.quote(openingText == null ? "" : openingText) + ")", null);
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(EtherePermissionsPlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        }

        View decorView = getWindow().getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decorView, (view, insets) -> {
            Insets statusBars = insets.getInsets(WindowInsetsCompat.Type.statusBars() | WindowInsetsCompat.Type.displayCutout());
            Insets navigationBars = insets.getInsets(WindowInsetsCompat.Type.navigationBars());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            boolean keyboardVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
            view.setPadding(0, statusBars.top, 0, keyboardVisible ? ime.bottom : navigationBars.bottom);
            return insets;
        });
        ViewCompat.requestApplyInsets(decorView);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() == null || getBridge().getWebView() == null) {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                    return;
                }
                getBridge().getWebView().evaluateJavascript(
                    "window.EthereHandleBack ? String(window.EthereHandleBack()) : 'false'",
                    value -> {
                        if (!"\"true\"".equals(value) && !"true".equals(value)) {
                            setEnabled(false);
                            getOnBackPressedDispatcher().onBackPressed();
                            setEnabled(true);
                        }
                    }
                );
            }
        });
    }
}
