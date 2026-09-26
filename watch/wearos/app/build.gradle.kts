import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The map a build starts with, if any. Behind a quick tunnel the map's address
// changes every time cloudflared restarts, so it cannot be built in: the watch
// asks for the map's name when it pairs (/pair gives it with the code). A
// deployment whose address stays — a named tunnel, the Worker — can build it
// in with LIVEGEO_SERVER or -Plivegeo.server=…, and its watches skip that
// question.
val server: String = System.getenv("LIVEGEO_SERVER")?.takeIf { it.isNotBlank() }
    ?: (findProperty("livegeo.server") as String?).orEmpty()

// The version and the signing key come from the release workflow
// (.github/workflows/watch.yml), the same way as the phone app's. A local build
// is a development version, and its release APK is left unsigned.
val versionCodeFromCi = System.getenv("LIVEGEO_VERSION_CODE")?.toIntOrNull() ?: 1
val versionNameFromCi = System.getenv("LIVEGEO_VERSION_NAME")?.takeIf { it.isNotBlank() } ?: "0.1-dev"
val keystore = System.getenv("LIVEGEO_KEYSTORE")?.takeIf { it.isNotBlank() }?.let { file(it) }

android {
    namespace = "org.livegeo.watch"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.livegeo.watch"
        // Wear OS 3, which is where Galaxy Watch 4 and later start. Xiaomi
        // Watch 2 and 2 Pro, and Pixel Watch, run Wear OS 4 or later.
        minSdk = 30
        targetSdk = 34
        versionCode = versionCodeFromCi
        versionName = versionNameFromCi
        buildConfigField("String", "SERVER", "\"$server\"")
    }

    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = keystore
                storePassword = System.getenv("LIVEGEO_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("LIVEGEO_KEY_ALIAS")
                keyPassword = System.getenv("LIVEGEO_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        // Release builds run lint's fatal checks; an app installed by hand on
        // a watch is not held to Play Store policy checks.
        checkReleaseBuilds = true
        abortOnError = true
        disable += setOf("ExpiredTargetSdkVersion", "OldTargetApi", "GradleDependency", "NewerVersionAvailable")
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation(project(":core"))
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.wear.compose:compose-material:1.4.0")
    implementation("androidx.wear.compose:compose-foundation:1.4.0")
    // The watch's own text input — keyboard, voice or handwriting — for the
    // map's name when pairing.
    implementation("androidx.wear:wear-input:1.1.0")
    implementation("com.google.android.gms:play-services-location:21.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
