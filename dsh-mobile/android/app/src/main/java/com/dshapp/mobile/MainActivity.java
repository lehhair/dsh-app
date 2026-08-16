package com.dshapp.mobile;

import android.content.res.Configuration;
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
            applyThemeChrome();
            // Follow day/night switches at runtime. ComponentCallbacks and
            // onConfigurationChanged both go silent for uiMode on some
            // devices/launchers, so poll the night flag — cheap and reliable.
            final int[] lastNight = { currentNightMode() };
            final android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());
            final Runnable poll = new Runnable() {
                @Override
                public void run() {
                    int night = currentNightMode();
                    if (night != lastNight[0]) {
                        lastNight[0] = night;
                        applyThemeChrome();
                    }
                    handler.postDelayed(this, 500);
                }
            };
            handler.postDelayed(poll, 500);
        });
    }

    private int currentNightMode() {
        return getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
    }

    /** Paint the strip above the WebView and the status-bar icons for the
     *  current theme. Called at launch and again on uiMode changes. */
    private void applyThemeChrome() {
        View webView = findWebView(getWindow().getDecorView());
        if (webView == null) return;
        boolean dark = currentNightMode() == Configuration.UI_MODE_NIGHT_YES;
        int pageColor = dark ? 0xFF151517 : 0xFFFFFFFF;
        ViewGroup parent = (ViewGroup) webView.getParent();
        if (parent != null) parent.setBackgroundColor(pageColor);
        // Icon contrast: light icons on dark, dark icons on light. Use the
        // modern insets-controller API — SYSTEM_UI_FLAG_LIGHT_STATUS_BAR is
        // ignored under Android 16's enforced edge-to-edge.
        View decor = getWindow().getDecorView();
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsetsController ic = decor.getWindowInsetsController();
            if (ic != null) {
                ic.setSystemBarsAppearance(
                        dark ? 0 : android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS,
                        android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS);
            }
        } else {
            int flags = decor.getSystemUiVisibility();
            if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            else flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            decor.setSystemUiVisibility(flags);
        }
        android.util.Log.i("DshNative", "theme chrome " + (dark ? "#151517 dark" : "#FFFFFF light"));
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
