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
        final String authKey = call.getString("key");
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

            // Full-screen immersive: the page draws behind the status bar.
            // Read the real status-bar height and inject a padding-top (in
            // CSS pixels!) so dsh's own content clears the bar while the
            // page keeps its full-bleed background. Only body gets the pad —
            // padding the first child too stacked two insets.
            final int statusBarPx = getStatusBarHeightPx();
            final int statusBarCssPx = Math.round(statusBarPx / getActivity().getResources().getDisplayMetrics().density);
            androidx.core.view.OnApplyWindowInsetsListener insetsListener = (view, insets) -> {
                view.setPadding(0, 0, 0, 0);
                return androidx.core.view.WindowInsetsCompat.CONSUMED;
            };
            androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(wv, insetsListener);
            if (statusBarCssPx > 0) {
                final String padJs = "if(!window.__dshAppPadApplied){" +
                    "window.__dshAppPadApplied=true;" +
                    "document.body.style.paddingTop='" + statusBarCssPx + "px';" +
                    "}";
                wv.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String pageUrl) {
                        super.onPageFinished(view, pageUrl);
                        view.evaluateJavascript(padJs, null);
                        if (injectScript != null && !injectScript.isEmpty()) {
                            view.evaluateJavascript(injectScript, null);
                        }
                    }

                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        return false;
                    }
                });
            } else {
                wv.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String pageUrl) {
                        super.onPageFinished(view, pageUrl);
                        if (injectScript != null && !injectScript.isEmpty()) {
                            view.evaluateJavascript(injectScript, null);
                        }
                    }

                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        return false;
                    }
                });
            }

            // Inject the gateway session cookie before any request fires.
            // SameSite=Strict is fine here: the WebView loads the gateway's
            // own origin, so the cookie is first-party to it.
            if (cookieName != null && cookieValue != null && !cookieValue.isEmpty()) {
                CookieManager cm = CookieManager.getInstance();
                cm.setAcceptCookie(true);
                cm.setCookie(url, cookieName + "=" + cookieValue + "; Path=/; Max-Age=604800");
                cm.flush();
                android.util.Log.i("DshNative", "cookie injected: " + cookieName + "=" + cookieValue.substring(0, Math.min(12, cookieValue.length())) + "... (" + cookieValue.length() + " chars)");
            } else {
                android.util.Log.i("DshNative", "no cookie to inject (login returned none)");
            }

            // The gateway accepts Bearer <key> directly (verified: 200), a
            // belt-and-braces against any SameSite edge case on the cookie.

            // Full-screen overlay above the Capacitor web content.
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT);
            ((ViewGroup) activity.getWindow().getDecorView()).addView(wv, params);
            webView = wv;
            if (authKey != null && !authKey.isEmpty()) {
                java.util.Map<String, String> headers = new java.util.HashMap<>();
                headers.put("Authorization", "Bearer " + authKey);
                wv.loadUrl(url, headers);
            } else {
                wv.loadUrl(url);
            }
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
     * Status bar height in CSS px (dp), read natively so the launcher can pad
     * its header below it — reliable on every Android version, unlike the
     * env(safe-area-inset-top) fallback on old WebViews.
     */
    @PluginMethod
    public void getStatusBarHeight(final PluginCall call) {
        int px = getStatusBarHeightPx();
        float density = getActivity().getResources().getDisplayMetrics().density;
        JSObject result = new JSObject();
        result.put("height", Math.round(px / density));
        result.put("px", px);
        call.resolve(result);
    }

    private int getStatusBarHeightPx() {
        int resourceId = getActivity().getResources().getIdentifier(
                "status_bar_height", "dimen", "android");
        return resourceId > 0
                ? getActivity().getResources().getDimensionPixelSize(resourceId)
                : 0;
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
                // Login endpoint is {origin}/_gateway/login (the desktop shell
                // posts there too); POSTing to the bare origin returns 401.
                String loginUrl = url.replaceAll("/+$", "") + "/_gateway/login";
                java.net.URL u = new java.net.URL(loginUrl);
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) u.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                conn.setDoOutput(true);
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                // Do NOT follow the 302: the session cookie lives on the
                // redirect response itself (same as the desktop shell reads
                // res.headers['set-cookie'] on the 302).
                conn.setInstanceFollowRedirects(false);
                String body = "key=" + java.net.URLEncoder.encode(key, "UTF-8") + "&next=/";
                conn.getOutputStream().write(body.getBytes("UTF-8"));
                conn.connect();
                int code = conn.getResponseCode();
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
                // Drain whatever body came back so the connection can close.
                java.io.InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                if (in != null) {
                    byte[] buf = new byte[4096];
                    while (in.read(buf) != -1) { /* drain */ }
                    in.close();
                }
                conn.disconnect();
                JSObject result = new JSObject();
                if (cookie != null) {
                    result.put("ok", true);
                    result.put("cookie", cookie);
                    android.util.Log.i("DshNative", "login ok, cookie len=" + cookie.length());
                } else {
                    result.put("ok", false);
                    result.put("error", "登录未返回会话 Cookie（检查访问密钥，HTTP " + code + "）");
                    android.util.Log.w("DshNative", "login no cookie, http=" + code);
                }
                call.resolve(result);
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
