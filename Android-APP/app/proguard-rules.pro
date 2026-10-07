# The default ViewModel factory instantiates this constructor reflectively.
# ProcessBuilder runs the native Node executable; it does not call Java JNI.
-keep,allowoptimization,allowobfuscation class com.zcode.proxy.ui.ProxyViewModel {
    public <init>();
}
-keep,allowoptimization,allowobfuscation class com.zcode.proxy.ui.UpdateViewModel {
    public <init>();
}
