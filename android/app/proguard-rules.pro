# Moshi
-keep class lol.tolerance.android.** { *; }
-keepclassmembers class lol.tolerance.android.** { *; }
-keep @com.squareup.moshi.JsonClass class * { *; }
-keepnames @com.squareup.moshi.JsonClass class *

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**

# Tink (under androidx.security:security-crypto) refers to compile-time-only annotations
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
