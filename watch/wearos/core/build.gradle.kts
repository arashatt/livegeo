plugins {
    id("org.jetbrains.kotlin.jvm")
}

// Bytecode Android can load, from whichever JDK is building it: a toolchain
// would insist on a JDK 17 being installed, which says nothing useful.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    // Android ships org.json in the platform, so the app gets it for free and
    // must not bundle a second copy; plain JVM tests need it from Maven.
    compileOnly("org.json:json:20240303")
    testImplementation("org.json:json:20240303")
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
}
