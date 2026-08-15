package com.dshapp.mobile;

import android.os.Bundle;

import androidx.core.view.WindowCompat;

import com.getcapacitor.BridgeActivity;
import com.dshapp.mobile.dshnative.DshNativePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DshNativePlugin.class);
        super.onCreate(savedInstanceState);
        // Explicitly opt into edge-to-edge so the launcher's background draws
        // behind the status bar; Capacitor's SystemBars plugin then supplies
        // --safe-area-inset-* and the header pads itself. On Android 15+
        // edge-to-edge is enforced anyway; this makes it true on older
        // versions too.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
    }
}
