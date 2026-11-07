package com.ethere.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;

public class EthereIncomingCallActivity extends Activity {
    private String callId = "";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        callId = getIntent().getStringExtra("ethere_call_id");
        JSONObject call = EthereIncomingCallManager.get(this, callId);
        if (call == null) { finish(); return; }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) { setShowWhenLocked(true); setTurnScreenOn(true); }
        else getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.rgb(15, 17, 23));
        getWindow().setNavigationBarColor(Color.rgb(15, 17, 23));
        getWindow().getDecorView().setSystemUiVisibility(0);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(24), dp(12), dp(24), dp(36));
        root.setBackgroundColor(Color.rgb(15, 17, 23));
        FrameLayout hero = new FrameLayout(this);
        root.addView(hero, new LinearLayout.LayoutParams(-1, 0, 1));
        LinearLayout identity = new LinearLayout(this);
        identity.setOrientation(LinearLayout.VERTICAL);
        identity.setGravity(Gravity.CENTER_HORIZONTAL);
        hero.addView(identity, new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER));
        ImageView avatar = new ImageView(this);
        avatar.setImageResource(R.mipmap.ic_launcher);
        avatar.setScaleType(ImageView.ScaleType.CENTER_CROP);
        GradientDrawable avatarBackground = new GradientDrawable();
        avatarBackground.setShape(GradientDrawable.OVAL);
        avatarBackground.setColor(Color.rgb(40, 42, 57));
        avatar.setBackground(avatarBackground);
        avatar.setClipToOutline(true);
        LinearLayout.LayoutParams avatarParams = new LinearLayout.LayoutParams(dp(104), dp(104));
        avatarParams.bottomMargin = dp(26);
        identity.addView(avatar, avatarParams);
        TextView title = new TextView(this);
        title.setText(call.optString("title", "Ethere"));
        title.setTextSize(25);
        title.setTextColor(Color.WHITE);
        title.setGravity(Gravity.CENTER);
        title.setMaxLines(2);
        identity.addView(title, new LinearLayout.LayoutParams(-1, -2));
        TextView subtitle = new TextView(this);
        subtitle.setText("语音来电");
        subtitle.setTextSize(14);
        subtitle.setTextColor(Color.rgb(165, 168, 183));
        subtitle.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subParams = new LinearLayout.LayoutParams(-1, -2);
        subParams.topMargin = dp(9);
        identity.addView(subtitle, subParams);
        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.CENTER);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        root.addView(actions, new LinearLayout.LayoutParams(-1, dp(124)));
        ImageView end = callAction(actions, "挂断", Color.rgb(222, 76, 79), true);
        ImageView answer = callAction(actions, "接听", Color.rgb(55, 184, 104), false);
        answer.setOnClickListener(view -> {
            stopRinging();
            EthereIncomingCallManager.finish(this, callId, "answered");
            Intent intent = new Intent(this, MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            intent.putExtra("ethere_answer_call", true);
            intent.putExtra("ethere_opening_text", call.optString("openingText", ""));
            startActivity(intent);
            finish();
        });
        end.setOnClickListener(view -> { stopRinging(); EthereIncomingCallManager.finish(this, callId, "ended"); finish(); });
        Button snooze = new Button(this);
        snooze.setAllCaps(false);
        snooze.setText("稍后提醒");
        snooze.setTextSize(13);
        snooze.setTextColor(Color.rgb(169, 171, 183));
        snooze.setBackgroundColor(Color.TRANSPARENT);
        LinearLayout.LayoutParams snoozeParams = new LinearLayout.LayoutParams(-1, dp(48));
        snoozeParams.topMargin = dp(17);
        root.addView(snooze, snoozeParams);
        snooze.setOnClickListener(view -> {
            try { EthereIncomingCallManager.snooze(this, callId); stopRinging(); finish(); }
            catch (Exception error) { subtitle.setText(error.getMessage() == null ? "无法设置稍后提醒" : error.getMessage()); }
        });
        setContentView(root);
    }

    @Override
    public void onBackPressed() { stopRinging(); EthereIncomingCallManager.finish(this, callId, "ended"); super.onBackPressed(); }

    @Override
    protected void onDestroy() { stopRinging(); super.onDestroy(); }

    private void stopRinging() { EthereIncomingCallManager.stopRinging(callId); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private ImageView callAction(LinearLayout row, String label, int color, boolean hangup) {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        LinearLayout.LayoutParams columnParams = new LinearLayout.LayoutParams(0, -1, 1);
        row.addView(column, columnParams);
        ImageView icon = new ImageView(this);
        icon.setImageResource(android.R.drawable.sym_action_call);
        icon.setColorFilter(Color.WHITE);
        icon.setPadding(dp(21), dp(21), dp(21), dp(21));
        if (hangup) icon.setRotation(135f);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(color);
        icon.setBackground(circle);
        icon.setContentDescription(label);
        column.addView(icon, new LinearLayout.LayoutParams(dp(72), dp(72)));
        TextView caption = new TextView(this);
        caption.setText(label);
        caption.setTextSize(14);
        caption.setTextColor(Color.rgb(223, 225, 232));
        caption.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams captionParams = new LinearLayout.LayoutParams(-1, dp(36));
        captionParams.topMargin = dp(7);
        column.addView(caption, captionParams);
        return icon;
    }
}
