// The phone app: the 3D map full-screen, with a native way in and a native
// way to share where you are. Two modules:
//
//   app   Android: the web view and the screens around it, the location
//         service. Needs the SDK, so it is built where one is installed,
//         which CI always has (.github/workflows/android.yml).
//   core  the watch app's plain-Kotlin core, used where it lives rather than
//         copied: the API client, the offline outbox, the send cadence, and
//         the rules the phone adds (finding the map's address in a shared
//         link, telling why it did not load, pairing with a session).
//
// The plugins are declared here so they share one classloader, as in the
// watch build (watch/wearos/settings.gradle.kts).
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
    plugins {
        id("com.android.application") version "8.7.3"
        id("org.jetbrains.kotlin.android") version "2.0.21"
        id("org.jetbrains.kotlin.jvm") version "2.0.21"
    }
}

dependencyResolutionManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google\\.android.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
    }
}

rootProject.name = "livegeo-android"
include(":core")
project(":core").projectDir = file("../watch/wearos/core")
include(":app")
