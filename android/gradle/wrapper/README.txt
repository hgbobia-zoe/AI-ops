gradle-wrapper.jar is a binary and is NOT checked in here.

Generate it once (either command works), from the `android/` directory:

    gradle wrapper --gradle-version 8.9

or simply open this project in Android Studio — it will offer to generate the
wrapper / download the Gradle distribution automatically on first sync.

After generation you will have:
    gradle/wrapper/gradle-wrapper.jar

which the `gradlew` / `gradlew.bat` scripts here invoke.
