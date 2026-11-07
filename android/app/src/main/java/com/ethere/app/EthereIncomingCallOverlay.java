package com.ethere.app;

import android.app.Dialog;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.view.Gravity;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;

final class EthereIncomingCallOverlay {
    private static Dialog current;
    private static String currentId = "";
    private static boolean handled;

    static synchronized boolean show(Context context, JSONObject call) {
        String id = call.optString("id", "");
        if (id.isEmpty()) return false;
        if (current != null) return currentId.equals(id);
        Dialog dialog = new Dialog(context, android.R.style.Theme_Material_NoActionBar);
        Window window = dialog.getWindow();
        if (window == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) window.setType(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY);
        window.setBackgroundDrawableResource(android.R.color.transparent);
        window.setFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL);

        LinearLayout root = new LinearLayout(context);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(context, 24), dp(context, 30), dp(context, 24), dp(context, 44));
        root.setBackgroundColor(Color.rgb(15, 17, 23));
        FrameLayout hero = new FrameLayout(context);
        root.addView(hero, new LinearLayout.LayoutParams(-1, 0, 1));
        LinearLayout identity = new LinearLayout(context);
        identity.setOrientation(LinearLayout.VERTICAL);
        identity.setGravity(Gravity.CENTER_HORIZONTAL);
        hero.addView(identity, new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER));
        ImageView avatar = new ImageView(context);
        avatar.setImageResource(R.mipmap.ic_launcher);
        avatar.setScaleType(ImageView.ScaleType.CENTER_CROP);
        GradientDrawable avatarBackground = new GradientDrawable();
        avatarBackground.setShape(GradientDrawable.OVAL);
        avatarBackground.setColor(Color.rgb(40, 42, 57));
        avatar.setBackground(avatarBackground);
        avatar.setClipToOutline(true);
        LinearLayout.LayoutParams avatarParams = new LinearLayout.LayoutParams(dp(context, 104), dp(context, 104));
        avatarParams.bottomMargin = dp(context, 26);
        identity.addView(avatar, avatarParams);
        TextView title = new TextView(context);
        title.setText(call.optString("title", "Ethere"));
        title.setTextSize(25);
        title.setTextColor(Color.WHITE);
        title.setGravity(Gravity.CENTER);
        title.setMaxLines(2);
        identity.addView(title, new LinearLayout.LayoutParams(-1, -2));
        TextView subtitle = new TextView(context);
        subtitle.setText("语音来电");
        subtitle.setTextSize(14);
        subtitle.setTextColor(Color.rgb(165, 168, 183));
        subtitle.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subParams = new LinearLayout.LayoutParams(-1, -2);
        subParams.topMargin = dp(context, 9);
        identity.addView(subtitle, subParams);

        LinearLayout actions = new LinearLayout(context);
        actions.setGravity(Gravity.CENTER);
        root.addView(actions, new LinearLayout.LayoutParams(-1, dp(context, 124)));
        ImageView end = callAction(context, actions, "挂断", Color.rgb(222, 76, 79), true);
        ImageView answer = callAction(context, actions, "接听", Color.rgb(55, 184, 104), false);
        end.setOnClickListener(view -> { handled = true; EthereIncomingCallManager.finish(context, id, "ended"); dismiss(id); });
        answer.setOnClickListener(view -> {
            handled = true;
            EthereIncomingCallManager.finish(context, id, "answered");
            dismiss(id);
            Intent intent = new Intent(context, MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            intent.putExtra("ethere_answer_call", true);
            intent.putExtra("ethere_opening_text", call.optString("openingText", ""));
            context.startActivity(intent);
        });
        Button snooze = new Button(context);
        snooze.setAllCaps(false);
        snooze.setText("稍后提醒");
        snooze.setTextSize(13);
        snooze.setTextColor(Color.rgb(169, 171, 183));
        snooze.setBackgroundColor(Color.TRANSPARENT);
        LinearLayout.LayoutParams snoozeParams = new LinearLayout.LayoutParams(-1, dp(context, 48));
        snoozeParams.topMargin = dp(context, 17);
        root.addView(snooze, snoozeParams);
        snooze.setOnClickListener(view -> {
            try { handled = true; EthereIncomingCallManager.snooze(context, id); dismiss(id); }
            catch (Exception error) { handled = false; subtitle.setText(error.getMessage() == null ? "无法设置稍后提醒" : error.getMessage()); }
        });
        dialog.setContentView(root);
        dialog.setOnDismissListener(ignored -> {
            synchronized (EthereIncomingCallOverlay.class) {
                if (current == dialog) { current = null; currentId = ""; }
            }
            if (!handled) EthereIncomingCallManager.finish(context, id, "ended");
            handled = false;
        });
        try {
            dialog.show();
            window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT);
            current = dialog;
            currentId = id;
            handled = false;
            return true;
        } catch (RuntimeException ignored) { handled = true; dialog.dismiss(); return false; }
    }

    static synchronized void dismiss(String id) {
        if (current == null || !currentId.equals(id)) return;
        handled = true;
        current.dismiss();
    }

    private static ImageView callAction(Context context, LinearLayout row, String label, int color, boolean hangup) {
        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        row.addView(column, new LinearLayout.LayoutParams(0, -1, 1));
        ImageView icon = new ImageView(context);
        icon.setImageResource(android.R.drawable.sym_action_call);
        icon.setColorFilter(Color.WHITE);
        icon.setPadding(dp(context, 21), dp(context, 21), dp(context, 21), dp(context, 21));
        if (hangup) icon.setRotation(135f);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(color);
        icon.setBackground(circle);
        icon.setContentDescription(label);
        column.addView(icon, new LinearLayout.LayoutParams(dp(context, 72), dp(context, 72)));
        TextView caption = new TextView(context);
        caption.setText(label);
        caption.setTextSize(14);
        caption.setTextColor(Color.rgb(223, 225, 232));
        caption.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams captionParams = new LinearLayout.LayoutParams(-1, dp(context, 36));
        captionParams.topMargin = dp(context, 7);
        column.addView(caption, captionParams);
        return icon;
    }

    private static int dp(Context context, int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
}
