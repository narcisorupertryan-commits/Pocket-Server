package com.pocketserver.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Brings the servers back after a reboot or an app update.
 *
 * Note: the foreground service can start here, so PocketBase (database, admin UI and
 * the hosted site) is reachable again without unlocking the phone. The Express control
 * panel is started by the Capacitor Node plugin, which needs the app to be opened once,
 * because Android forbids starting activities from the background.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        boolean relevant = Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);

        if (!relevant) return;

        try {
            ServerService.start(context);
            Log.i(ServerService.TAG, "service started after " + action);
        } catch (Exception error) {
            Log.e(ServerService.TAG, "could not start the service after " + action, error);
        }
    }
}
