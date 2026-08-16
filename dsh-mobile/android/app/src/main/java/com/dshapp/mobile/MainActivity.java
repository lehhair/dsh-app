package com.dshapp.mobile;

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
        // Capacitor's default bridge layout (CoordinatorLayout) places the
        // WebView below the status bar; the strip above it shows the
        // CoordinatorLayout's background. Paint that parent with the page
        // color so the strip is invisible — the bar and page read as one
        // surface on every Android version, without fighting edge-to-edge.
        getWindow().getDecorView().post(() -> {
            View webView = findWebView(getWindow().getDecorView());
            if (webView == null) return;
            int nightMode = getResources().getConfiguration().uiMode
                    & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
            boolean dark = nightMode == android.content.res.Configuration.UI_MODE_NIGHT_YES;
            int pageColor = dark ? 0xFF151517 : 0xFFFFFFFF;
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) parent.setBackgroundColor(pageColor);
            // Icon contrast: light icons on dark, dark icons on light.
            View decor = getWindow().getDecorView();
            int flags = decor.getSystemUiVisibility();
            if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            else flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            decor.setSystemUiVisibility(flags);
            android.util.Log.i("DshNative", "parent bg " + (dark ? "#151517" : "#FFFFFF"));
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
