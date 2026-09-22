// The Galaxy Watch app. Two modules, split along what can be verified where:
//
//   core  plain Kotlin — the API client, the offline outbox, sharing sessions,
//         the send cadence, the tile maths. No Android in it, so it builds and
//         is tested anywhere, including machines without the Android SDK.
//   app   the Android and Wear OS layer around it: screens, the location
//         service, permissions. Needs the SDK, so it is only included where
//         one is installed — which CI always has.
//
// The plugins are declared at the root so they share a classloader, which
// means configuring even :core alone needs Google's Maven repository.
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
        id("org.jetbrains.kotlin.plugin.compose") version "2.0.21"
        id("org.jetbrains.kotlin.jvm") version "2.0.21"
    }
}

dependencyResolutionManagement {
    repositories {
        // Only what Google actually hosts is asked of Google; everything else
        // goes straight to Maven Central instead of trying Google first.
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

rootProject.name = "livegeo-watch"
include(":core")
if (System.getenv("ANDROID_HOME") != null || System.getenv("ANDROID_SDK_ROOT") != null) {
    include(":app")
}
