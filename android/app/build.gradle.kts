import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// URLs and the exit PIN are read from a local, un-committed `kiosk.properties` if
// present, otherwise fall back to the defaults below. This lets a fleet build the
// APK for a different environment without editing source. See android/README.md.
val kioskProps = Properties().apply {
    val f = rootProject.file("kiosk.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun prop(key: String, default: String): String =
    (kioskProps.getProperty(key) ?: System.getenv(key) ?: default)

android {
    namespace = "com.zoeevents.dispatch.kiosk"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.zoeevents.dispatch.kiosk"
        minSdk = 26
        targetSdk = 35
        versionCode = 12
        versionName = "1.0.11"

        // Configurable endpoints exposed to code as BuildConfig fields. Config.kt
        // reads these as its defaults and allows a runtime override on top.
        buildConfigField("String", "APP_URL",
            "\"${prop("APP_URL", "https://zoe-dispatch.fly.dev")}\"")
        buildConfigField("String", "GSPRO_URL",
            "\"${prop("GSPRO_URL", "https://pro.goodshuffle.com/app/rms/dashboard")}\"")
        buildConfigField("String", "IGNITION_URL",
            "\"${prop("IGNITION_URL", "https://ignition.zonarsystems.com/app/realtimemaps/main")}\"")
        buildConfigField("String", "EXIT_PIN",
            "\"${prop("EXIT_PIN", "1379")}\"")
        buildConfigField("String", "UNHIDE_PIN",
            "\"${prop("UNHIDE_PIN", "1379")}\"")

        // Phone number Zonar/Ignition attaches to a created ETA link. MUST be the Zoe
        // main line, NEVER the customer's number: Zonar sends its OWN unbranded text to
        // whatever number is on the ETA, so pointing it at the customer would double-text
        // them with an off-brand message. The customer only ever gets our branded Quo SMS
        // (which carries the link). See KioskJsBridge.createEtaLink.
        buildConfigField("String", "ETA_NOTIFY_PHONE",
            "\"${prop("ETA_NOTIFY_PHONE", "3012915296")}\"")
    }

    // Release signing. The keystore + passwords live OUTSIDE git (keystore/*.jks and
    // kiosk.properties are .gitignored). If the keystore is absent (e.g. a clean CI
    // checkout) the release build is simply left unsigned rather than failing.
    val releaseStore = rootProject.file(prop("RELEASE_STORE_FILE", "keystore/zoe-release.jks"))
    signingConfigs {
        if (releaseStore.exists()) {
            create("release") {
                storeFile = releaseStore
                storePassword = prop("RELEASE_STORE_PASSWORD", "ZoeDispatch2026")
                keyAlias = prop("RELEASE_KEY_ALIAS", "zoe")
                keyPassword = prop("RELEASE_KEY_PASSWORD", "ZoeDispatch2026")
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    buildFeatures {
        buildConfig = true
        viewBinding = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.constraintlayout:constraintlayout:2.2.0")
    // AndroidX WebKit — modern WebView APIs (safe-browsing, feature detection).
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.google.android.material:material:1.12.0")
}
