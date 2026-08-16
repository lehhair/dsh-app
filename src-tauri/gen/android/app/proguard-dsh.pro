# dsh-app: the Rust side instantiates DshNativePlugin by name via reflection
# (register_android_plugin) — never strip it.
-keep class com.dshapp.app.DshNativePlugin { *; }
