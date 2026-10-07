# syntax=docker/dockerfile:1
# Android APK build image for scripts/build-android-apk.sh
# Build: docker build -t llama-android-builder:latest -f scripts/android-builder.Dockerfile scripts/
# JDK 17 / SDK 35 / build-tools 35.0.0. Gradle is supplied by the wrapper.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        openjdk-17-jdk-headless curl ca-certificates unzip zip \
    && rm -rf /var/lib/apt/lists/*

# The repository Gradle wrapper supplies the pinned Gradle version.

# Android cmdline-tools + SDK 35（cmdline-tools 必须落在 $ANDROID_HOME/cmdline-tools/latest）
ARG CMDLINE_TOOLS_VERSION=11076708
ENV ANDROID_HOME=/opt/android-sdk
RUN curl -fsSLo /tmp/clt.zip \
        "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" \
    && mkdir -p "${ANDROID_HOME}/cmdline-tools" \
    && unzip -q /tmp/clt.zip -d "${ANDROID_HOME}/cmdline-tools" \
    && mv "${ANDROID_HOME}/cmdline-tools/cmdline-tools" "${ANDROID_HOME}/cmdline-tools/latest" \
    && rm /tmp/clt.zip
ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}"
RUN yes | sdkmanager --licenses >/dev/null \
    && sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
    && chmod -R a+rX "${ANDROID_HOME}"
