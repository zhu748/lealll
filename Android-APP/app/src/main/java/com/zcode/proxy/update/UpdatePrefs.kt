package com.zcode.proxy.update

import android.content.Context

/** Keep preference keys stable across APK upgrades. */
object UpdatePrefs {
    private const val PREFS = "update_prefs"
    private const val KEY_SKIPPED_TAG = "skipped_tag"
    private const val KEY_AUTO_CHECK = "auto_check"

    fun loadSkipped(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SKIPPED_TAG, null)

    fun saveSkipped(context: Context, tag: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_SKIPPED_TAG, tag).apply()
    }

    fun loadAutoCheck(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_AUTO_CHECK, true)

    fun saveAutoCheck(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_AUTO_CHECK, enabled).apply()
    }
}
