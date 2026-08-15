package com.dshapp.mobile;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;

import com.getcapacitor.BridgeActivity;
import com.dshapp.mobile.dshnative.DshNativePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DshNativePlugin.class);
        super.onCreate(savedInstanceState);
        // Immersive status bar at the native level — independent of any JS
        // timing: the page draws behind the status bar and the launcher's
        // header pads itself with safe-area-inset-top. Icon color follows the
        // system dark-mode state.
        makeStatusBarImmersive();
    }

    private void makeStatusBarImmersive() {
        Window window = getWindow();
        View decor = window.getDecorView();
        int nightMode = getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
        boolean dark = nightMode == android.content.res.Configuration.UI_MODE_NIGHT_YES;

        // The status bar itself must be transparent so the page background
        // shows through (that is the "fused" look). Icon color follows the
        // system dark mode: light icons on dark, dark icons on light.
        window.setStatusBarColor(android.graphics.Color.TRANSPARENT);

        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = decor.getWindowInsetsController();
            if (controller != null) {
                controller.setSystemBarsAppearance(
                        dark ? 0 : WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS,
                        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS);
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
            decor.setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        } else {
            decor.setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | (dark ? 0 : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR));
        }
    }
}
