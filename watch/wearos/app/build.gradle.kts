import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Which server this build belongs to. One app per deployment: typing a URL on
// a watch is not something to ask of anybody. LIVEGEO_SERVER wins over
// gradle.properties, so CI can build for the real deployment.
val server: String = System.getenv("LIVEGEO_SERVER")?.takeIf { it.isNotBlank() }
    ?: (findProperty("livegeo.server") as String)

android {
    namespace = "org.livegeo.watch"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.livegeo.watch"
        // Wear OS 3, which is where Galaxy Watch 4 and later start.
        minSdk = 30
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"
        buildConfigField("String", "SERVER", "\"$server\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
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
    implementation("com.google.android.gms:play-services-location:21.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
