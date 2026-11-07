package com.ethere.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class EthereIncomingCallReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) EthereIncomingCallManager.rescheduleAfterBoot(context);
        else if (EthereIncomingCallManager.ACTION_ALARM.equals(intent.getAction())) EthereIncomingCallManager.showIncoming(context, intent.getStringExtra("ethere_call_id"));
    }
}
