package com.ethere.app;

import android.app.Dialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

final class EthereAttentionOverlay {
    interface ResultListener { void onResult(String actionId); }

    private static Dialog current;
    private static String currentId;

    static synchronized boolean show(Context context, JSONObject action, ResultListener listener) {
        String id = action.optString("id", "");
        if (current != null && current.isShowing()) return id.equals(currentId);
        final boolean[] delivered = { false };
        final boolean[] shown = { false };
        Dialog dialog = new Dialog(context, android.R.style.Theme_Material_NoActionBar);
        Window window = dialog.getWindow();
        if (window == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) window.setType(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY);
        window.setBackgroundDrawableResource(android.R.color.transparent);
        LinearLayout root = new LinearLayout(context);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(context, 24), dp(context, 28), dp(context, 24), dp(context, 88));
        root.setBackground(new GradientDrawable(GradientDrawable.Orientation.TL_BR,
            new int[] { Color.rgb(25, 25, 28), Color.rgb(9, 8, 15) }));

        FrameLayout header = new FrameLayout(context);
        root.addView(header, new LinearLayout.LayoutParams(-1, dp(context, 52)));

        TextView close = new TextView(context);
        close.setText("×");
        close.setTextColor(Color.rgb(207, 207, 215));
        close.setTextSize(28);
        close.setGravity(Gravity.CENTER);
        close.setContentDescription("关闭监督弹窗");
        header.addView(close, new FrameLayout.LayoutParams(dp(context, 52), dp(context, 52), Gravity.END | Gravity.TOP));
        close.setOnClickListener(view -> dialog.dismiss());

        ScrollView scroll = new ScrollView(context);
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        TextView message = new TextView(context);
        message.setText(action.optString("message", ""));
        message.setTextColor(Color.rgb(245, 244, 248));
        message.setTextSize(26);
        message.setGravity(Gravity.CENTER);
        message.setLineSpacing(dp(context, 5), 1f);
        message.setPadding(0, dp(context, 24), 0, dp(context, 24));
        scroll.addView(message, new ScrollView.LayoutParams(-1, -1));

        LinearLayout buttons = new LinearLayout(context);
        buttons.setOrientation(LinearLayout.VERTICAL);
        root.addView(buttons, new LinearLayout.LayoutParams(-1, -2));
        JSONArray actions = action.optJSONArray("actions");
        if (actions != null) for (int i = 0; i < actions.length(); i++) {
            JSONObject choice = actions.optJSONObject(i);
            if (choice == null) continue;
            Button button = new Button(context);
            button.setAllCaps(false);
            button.setText(choice.optString("label"));
            button.setTextSize(16);
            button.setTextColor(i == 0 ? Color.rgb(27, 27, 33) : Color.rgb(232, 231, 239));
            GradientDrawable buttonBackground = new GradientDrawable();
            buttonBackground.setColor(i == 0 ? Color.rgb(169, 168, 176) : Color.rgb(45, 44, 53));
            buttonBackground.setCornerRadius(dp(context, 30));
            button.setBackground(buttonBackground);
            LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(-1, dp(context, 56));
            if (i > 0) buttonParams.topMargin = dp(context, 10);
            buttons.addView(button, buttonParams);
            String actionId = choice.optString("id", "");
            button.setOnClickListener(view -> {
                if (!delivered[0]) { delivered[0] = true; listener.onResult(actionId); }
                dialog.dismiss();
            });
        }
        dialog.setContentView(root);
        dialog.setCanceledOnTouchOutside(false);
        dialog.setOnDismissListener(ignored -> {
            synchronized (EthereAttentionOverlay.class) { if (current == dialog) { current = null; currentId = null; } }
            if (shown[0] && !delivered[0]) { delivered[0] = true; listener.onResult("dismissed"); }
        });
        try {
            dialog.show();
            shown[0] = true;
            window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT);
            root.setAlpha(0f);
            root.animate().alpha(1f).setDuration(180).start();
            current = dialog;
            currentId = id;
            return true;
        } catch (RuntimeException error) {
            delivered[0] = true;
            dialog.dismiss();
            return false;
        }
    }

    private static int dp(Context context, int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
}
