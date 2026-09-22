// Every plugin declared once, here, so they share one classloader. Applied
// separately in :app and :core, the Kotlin plugin was loaded twice, which
// Gradle warns may break the build — and the Kotlin Android plugin has to see
// the Android plugin's classes, which it only can from the same loader.
plugins {
    id("com.android.application") apply false
    id("org.jetbrains.kotlin.android") apply false
    id("org.jetbrains.kotlin.plugin.compose") apply false
    id("org.jetbrains.kotlin.jvm") apply false
}
