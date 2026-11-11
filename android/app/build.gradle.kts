import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}

android {
    namespace = "lol.tolerance.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "lol.tolerance.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    // The sideloaded build's release key. Lives outside the repo (keystore.properties is
    // gitignored); every update must be signed with it, so it can never be replaced.
    val keystoreProps = rootProject.file("keystore.properties").takeIf { it.exists() }?.let { file ->
        Properties().apply { file.inputStream().use { load(it) } }
    }
    signingConfigs {
        if (keystoreProps != null) {
            create("sideload") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        // The release build, shrunk and optimized, but debug-signed: installs over a debug
        // build on a test phone, so release-only breakage shows up before a release
        create("staging") {
            initWith(getByName("release"))
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += "release"
            versionNameSuffix = "-staging"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // Google Play doesn't allow interfering with other apps' ads, so its build leaves ads
    // alone entirely. The sideloaded build (full) covers them.
    flavorDimensions += "distribution"
    productFlavors {
        create("full") {
            dimension = "distribution"
            buildConfigField("boolean", "AD_BLOCKING", "true")
            // Released on GitHub (gtech/tolerance, tags android-v*), so it checks there for updates
            buildConfigField("boolean", "GITHUB_UPDATES", "true")
            // Debug and staging builds keep their own debug signing (build types win)
            signingConfigs.findByName("sideload")?.let { signingConfig = it }
        }
        create("play") {
            dimension = "distribution"
            versionNameSuffix = "-play"
            buildConfigField("boolean", "AD_BLOCKING", "false")
            // Google Play updates it
            buildConfigField("boolean", "GITHUB_UPDATES", "false")
            // Unsigned: uploaded to Play, which signs it
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        // Robolectric reads the merged manifest and resources
        unitTests.isIncludeAndroidResources = true
    }
}

dependencies {
    // Kotlin
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // AndroidX Core
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")

    // Jetpack Compose (BOM)
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // Room
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // OkHttp
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Moshi (JSON)
    implementation("com.squareup.moshi:moshi:1.15.1")
    implementation("com.squareup.moshi:moshi-kotlin:1.15.1")
    ksp("com.squareup.moshi:moshi-kotlin-codegen:1.15.1")

    // Encrypted SharedPreferences
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Unit tests
    testImplementation("junit:junit:4.13.2")
    // Real AccessibilityNodeInfo trees on the JVM, built from sanitized screen captures
    testImplementation("org.robolectric:robolectric:4.14.1")
}
