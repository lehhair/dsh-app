package com.dshapp.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.dshapp.mobile.dshnative.DshNativePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DshNativePlugin.class);
        super.onCreate(savedInstanceState);
        // Status bar / safe-area handling belongs to Capacitor's built-in
        // SystemBars plugin (edge-to-edge + CSS insets); nothing to do here.
    }
}
