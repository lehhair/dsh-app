package com.dshapp.mobile;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.dshapp.mobile.dshnative.DshNativePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DshNativePlugin.class);
        super.onCreate(savedInstanceState);
        // The white strip above the WebView is the CoordinatorLayout root
        // background (Capacitor's default layout puts the WebView below the
        // status bar and paints its own background above it). Paint that
        // parent with the page color so the strip is invisible.
        getWindow().getDecorView().post(() -> {
            View webView = findWebView(getWindow().getDecorView());
            if (webView == null) return;
            int nightMode = getResources().getConfiguration().uiMode
                    & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
            boolean dark = nightMode == android.content.res.Configuration.UI_MODE_NIGHT_YES;
            int pageColor = dark ? 0xFF151517 : 0xFFFFFFFF;
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) parent.setBackgroundColor(pageColor);
            android.util.Log.i("DshNative", "parent bg " + (dark ? "#151517" : "#FFFFFF")
                    + " parent=" + (parent != null ? parent.getClass().getSimpleName() : "null"));
        });
    }

    private View findWebView(View root) {
        if (root instanceof WebView) return root;
        if (root instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) root;
            for (int i = 0; i < group.getChildCount(); i++) {
                View found = findWebView(group.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }
}
