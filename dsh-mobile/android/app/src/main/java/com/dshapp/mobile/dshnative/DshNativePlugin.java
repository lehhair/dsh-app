package com.dshapp.mobile.dshnative;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Bitmap;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.OnBackPressedDispatcher;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * DshNative: an in-app WebView that behaves like the desktop shell's
 * WebContentsView — loads a remote dsh gateway with the session cookie
 * injected BEFORE the first request (no login flash), and can inject the
 * "回到启动页" button script into the dsh settings panel. The WebView is a
 * full-screen overlay on top of the Capacitor activity.
 */
@CapacitorPlugin(name = "DshNative")
public class DshNativePlugin extends Plugin {

    private WebView webView = null;
    private OnBackPressedCallback backCallback = null;

    @PluginMethod
    public void open(final PluginCall call) {
        String url = call.getString("url");
        String cookieName = call.getString("cookieName");
        String cookieValue = call.getString("cookieValue");
        String injectScript = call.getString("injectScript");
        if (url == null) {
            call.reject("url is required");
            return;
        }

        final Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            if (webView != null) closeWebView();

            // Own the system back button while the WebView is up: history
            // back first, then close it (pop back to the launcher).
            androidx.activity.ComponentActivity componentActivity =
                (androidx.activity.ComponentActivity) activity;
            OnBackPressedDispatcher dispatcher = componentActivity.getOnBackPressedDispatcher();
            if (backCallback != null) backCallback.remove();
            backCallback = new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    if (webView != null && webView.canGoBack()) {
                        webView.goBack();
                    } else {
                        closeWebView();
                    }
                }
            };
            dispatcher.addCallback(componentActivity, backCallback);

            WebView wv = new WebView(activity);
            wv.setBackgroundColor(0xFF151517); // dsh dark ground while booting
            WebSettings settings = wv.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            // The injected "回到启动页" button calls this to pop back.
            wv.addJavascriptInterface(new Object() {
                @android.webkit.JavascriptInterface
                public void close() {
                    activity.runOnUiThread(DshNativePlugin.this::closeWebView);
                }
            }, "DshNativeBridge");

            // Inject the gateway session cookie before any request fires.
            if (cookieName != null && cookieValue != null) {
                CookieManager cm = CookieManager.getInstance();
                cm.setAcceptCookie(true);
                cm.setCookie(url, cookieName + "=" + cookieValue + "; Path=/");
            }

            wv.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String pageUrl) {
                    super.onPageFinished(view, pageUrl);
                    // Inject the back-button script on every finished load
                    // (the settings panel re-mounts between navigations).
                    if (injectScript != null && !injectScript.isEmpty()) {
                        view.evaluateJavascript(injectScript, null);
                    }
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    // Returning false lets the WebView handle navigation
                    // itself — returning true + loadUrl() here would recurse.
                    return false;
                }
            });

            // Full-screen overlay above the Capacitor web content.
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT);
            ((ViewGroup) activity.getWindow().getDecorView()).addView(wv, params);
            webView = wv;
            wv.loadUrl(url);
            call.resolve();
        });
    }

    @PluginMethod
    public void close(final PluginCall call) {
        final Activity activity = getActivity();
        activity.runOnUiThread(this::closeWebView);
        call.resolve();
    }

    /**
     * POST {origin}/_gateway/login with key=...&next=/ (the same login the
     * desktop shell performs) and return the dsh_gateway_key cookie value, so
     * the launcher can hand it to {@link #open} for pre-injection. Done on a
     * background thread — network I/O is never allowed on the UI thread.
     */
    @PluginMethod
    public void login(final PluginCall call) {
        String url = call.getString("url");
        String key = call.getString("key");
        if (url == null || key == null) {
            call.reject("url and key are required");
            return;
        }
        Thread t = new Thread(() -> {
            try {
                java.net.URL u = new java.net.URL(url);
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) u.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                conn.setDoOutput(true);
                conn.setInstanceFollowRedirects(true);
                String body = "key=" + java.net.URLEncoder.encode(key, "UTF-8") + "&next=/";
                conn.getOutputStream().write(body.getBytes("UTF-8"));
                conn.connect();
                // Drain the body so the connection is usable.
                java.io.InputStream in = conn.getInputStream();
                byte[] buf = new byte[4096];
                while (in.read(buf) != -1) { /* drain */ }
                in.close();
                java.util.List<String> cookies = conn.getHeaderFields().get("Set-Cookie");
                String cookie = null;
                if (cookies != null) {
                    for (String c : cookies) {
                        String[] parts = c.split(";");
                        if (parts.length > 0 && parts[0].startsWith("dsh_gateway_key=")) {
                            cookie = parts[0].substring("dsh_gateway_key=".length());
                            break;
                        }
                    }
                }
                JSObject result = new JSObject();
                if (cookie != null) {
                    result.put("ok", true);
                    result.put("cookie", cookie);
                } else {
                    result.put("ok", false);
                    result.put("error", "登录未返回会话 Cookie（检查访问密钥）");
                }
                call.resolve(result);
                conn.disconnect();
            } catch (Exception e) {
                call.reject("无法连接网关：" + e.getMessage());
            }
        });
        t.start();
    }

    /**
     * Probe a gateway's reachability (same semantics as the desktop health
     * check): 200 -> online, 401 -> unauthorized (bad key), else offline.
     * Runs off the UI thread; no CORS wall for native HTTP.
     */
    @PluginMethod
    public void health(final PluginCall call) {
        String url = call.getString("url");
        String key = call.getString("key");
        if (url == null) {
            call.reject("url is required");
            return;
        }
        Thread t = new Thread(() -> {
            try {
                java.net.URL u = new java.net.URL(url);
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) u.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(4000);
                conn.setReadTimeout(4000);
                if (key != null && !key.isEmpty()) {
                    conn.setRequestProperty("Authorization", "Bearer " + key);
                }
                conn.connect();
                int code = conn.getResponseCode();
                // Drain whatever body came back so the connection can close.
                java.io.InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                if (in != null) {
                    byte[] buf = new byte[4096];
                    while (in.read(buf) != -1) { /* drain */ }
                    in.close();
                }
                conn.disconnect();
                JSObject result = new JSObject();
                if (code == 200) result.put("status", "online");
                else if (code == 401) result.put("status", "unauthorized");
                else result.put("status", "offline");
                call.resolve(result);
            } catch (Exception e) {
                JSObject result = new JSObject();
                result.put("status", "offline");
                call.resolve(result);
            }
        });
        t.start();
    }

    private void closeWebView() {
        if (backCallback != null) {
            backCallback.remove();
            backCallback = null;
        }
        if (webView != null) {
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) parent.removeView(webView);
            webView.destroy();
            webView = null;
        }
    }
}
