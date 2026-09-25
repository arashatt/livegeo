import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The version and the signing key come from the release workflow
// (.github/workflows/android.yml). A local build is a development version,
// and its release APK is left unsigned.
val versionCodeFromCi = System.getenv("LIVEGEO_VERSION_CODE")?.toIntOrNull() ?: 1
val versionNameFromCi = System.getenv("LIVEGEO_VERSION_NAME")?.takeIf { it.isNotBlank() } ?: "0.1-dev"
val keystore = System.getenv("LIVEGEO_KEYSTORE")?.takeIf { it.isNotBlank() }?.let { file(it) }

android {
    namespace = "org.livegeo.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.livegeo.app"
        // Android 7: old enough for the car head units this is meant for too.
        // The page itself falls back to the classic map where WebGL2 is
        // missing, so an old web view still gets a working map.
        minSdk = 24
        targetSdk = 34
        versionCode = versionCodeFromCi
        versionName = versionNameFromCi
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
            // Not shrunk: the web view calls into the app by method name, and
            // a first release is not the place to find out which of those a
            // shrinker renamed.
            isMinifyEnabled = false
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        // Release builds run lint's fatal checks; a sideloaded app for phones
        // and car head units is not held to Play Store policy checks.
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
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
