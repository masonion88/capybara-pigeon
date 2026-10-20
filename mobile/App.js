// Capybara Pigeon for phones (Expo Go).
//
// The whole app UI is the web app served by the Capybara Pigeon server, shown full
// screen. This shell adds what a web page can't do on its own: it shares the phone's
// GPS with the page (so alerts and "My location" are real) and plays haptics.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { WebView } from 'react-native-webview';
import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';

// The server's port comes from the project's .env (see app.config.js).
const SERVER_PORT = String(process.env.EXPO_PUBLIC_SERVER_PORT || Constants.expoConfig?.extra?.serverPort || '3000');
const LOAD_TIMEOUT_MS = 20000;
const LOCATION_HEARTBEAT_MS = 45000; // re-share the position so the page knows it's still fresh

const colors = { bg: '#f9f7f1', card: '#ffffff', line: '#e8e2d6', text: '#3d3a36', muted: '#7d766c', capy: '#8b5a2b', matcha: '#8fb996', matchaDeep: '#7a9f81' };

// Where the server lives. By default: the computer running `expo start` (the phone
// already reaches it to load this app), on the server's port. Set EXPO_PUBLIC_SERVER_URL
// to use a tunnel or a deployed server instead.
function defaultServerUrl() {
  if (process.env.EXPO_PUBLIC_SERVER_URL) return process.env.EXPO_PUBLIC_SERVER_URL.replace(/\/+$/, '');
  const hostUri = Constants.expoConfig?.hostUri || Constants.expoGoConfig?.debuggerHost || '';
  const host = hostUri.split(':')[0];
  // In tunnel mode the host is Expo's tunnel, which doesn't carry the server's port.
  if (!host || host.endsWith('.exp.direct')) return '';
  return `http://${host}:${SERVER_PORT}`;
}

function normalizeUrl(input) {
  const url = input.trim().replace(/\/+$/, '');
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `http://${url}`;
}

function Shell() {
  const insets = useSafeAreaInsets();
  const webRef = useRef(null);
  const lastLocation = useRef(null);
  const lastHeading = useRef(null);
  const [serverUrl, setServerUrl] = useState(defaultServerUrl);
  const [draftUrl, setDraftUrl] = useState(serverUrl);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState(serverUrl ? 'loading' : 'error'); // 'loading' | 'ready' | 'error'

  // ---- GPS -> page ----
  const shareLocation = useCallback(() => {
    if (!lastLocation.current) return;
    webRef.current?.injectJavaScript(`window.CapybaraPigeon && window.CapybaraPigeon.setLocation(${JSON.stringify(lastLocation.current)}); true;`);
  }, []);
  const shareHeading = useCallback(() => {
    if (lastHeading.current == null) return;
    webRef.current?.injectJavaScript(`window.CapybaraPigeon && window.CapybaraPigeon.setHeading(${lastHeading.current}); true;`);
  }, []);

  useEffect(() => {
    let subscription;
    let compass;
    let cancelled = false;
    const onPosition = (position) => {
      lastLocation.current = { lng: position.coords.longitude, lat: position.coords.latitude, accuracy: position.coords.accuracy };
      shareLocation();
    };
    (async () => {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted' || cancelled) return;
      const last = await Location.getLastKnownPositionAsync();
      if (last && !cancelled) onPosition(last);
      // GPS-level accuracy and frequent updates, so the dot follows you as you walk.
      subscription = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, distanceInterval: 2, timeInterval: 1000 }, onPosition);
      // Compass: tell the page which way the phone is pointing, when it changes noticeably.
      compass = await Location.watchHeadingAsync((heading) => {
        const degrees = heading.trueHeading >= 0 ? heading.trueHeading : heading.magHeading;
        const last = lastHeading.current;
        if (last != null && Math.abs(((degrees - last + 540) % 360) - 180) < 2) return;
        lastHeading.current = Math.round(degrees);
        shareHeading();
      });
      if (cancelled) {
        subscription.remove();
        compass.remove();
      }
    })().catch(() => {
      // no location: the page falls back to its stand-in spot
    });
    // Re-share both now and then, so a page that loaded late (or reloaded) still gets them.
    const heartbeat = setInterval(() => {
      shareLocation();
      shareHeading();
    }, LOCATION_HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(heartbeat);
      subscription?.remove();
      compass?.remove();
    };
  }, [shareLocation, shareHeading]);

  // ---- page -> native ----
  const onMessage = useCallback(
    (event) => {
      let message;
      try {
        message = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      if (message.type === 'ready') {
        setStatus('ready'); // the page is up, even if a slow map tile is still loading
        shareLocation();
        shareHeading();
      } else if (message.type === 'open' && /^https:\/\//i.test(message.url || '')) {
        Linking.openURL(message.url).catch(() => {}); // e.g. the "text the pigeon" link
      } else if (message.type === 'haptic') {
        const buzz =
          message.kind === 'success'
            ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
            : message.kind === 'warning'
              ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
              : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        buzz.catch(() => {});
      }
    },
    [shareLocation, shareHeading],
  );

  // Give up on a server that never answers instead of spinning forever.
  useEffect(() => {
    if (status !== 'loading') return undefined;
    const timer = setTimeout(() => setStatus('error'), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status, attempt, serverUrl]);

  const retry = useCallback(() => {
    const url = normalizeUrl(draftUrl);
    if (!url) return;
    setDraftUrl(url);
    setServerUrl(url);
    setStatus('loading');
    setAttempt((n) => n + 1);
  }, [draftUrl]);

  // Links that leave the app (map credits and the like) open in the phone's browser.
  const keepInApp = useCallback(
    (request) => {
      if (request.url.startsWith(serverUrl) || request.url.startsWith('about:')) return true;
      if (/^https?:\/\//i.test(request.url)) Linking.openURL(request.url).catch(() => {});
      return false;
    },
    [serverUrl],
  );

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <View style={{ height: insets.top, backgroundColor: colors.bg }} />

      {serverUrl && status !== 'error' ? (
        <WebView
          key={`${serverUrl}#${attempt}`}
          ref={webRef}
          source={{ uri: serverUrl }}
          style={styles.web}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          bounces={false}
          overScrollMode="never"
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures={false}
          onMessage={onMessage}
          onLoad={() => setStatus('ready')}
          onError={() => setStatus('error')}
          onHttpError={(event) => {
            // Only the page itself failing counts, not a missing icon or map tile.
            if ((event.nativeEvent.url || '').replace(/\/+$/, '') === serverUrl) setStatus('error');
          }}
          onShouldStartLoadWithRequest={keepInApp}
        />
      ) : null}

      {status === 'loading' ? (
        <View style={[styles.cover, { top: insets.top }]}>
          <Text style={styles.mascots}>🦫🐦</Text>
          <Text style={styles.title}>Waking up the capybara…</Text>
          <ActivityIndicator color={colors.matchaDeep} style={styles.spinner} />
        </View>
      ) : null}

      {status === 'error' ? (
        <View style={[styles.cover, { top: insets.top }]}>
          <Text style={styles.mascots}>🦫💤</Text>
          <Text style={styles.title}>Can't find the Capybara Pigeon server</Text>
          <Text style={styles.help}>
            1. On your computer, run <Text style={styles.code}>npm start</Text> in the CapybaraPigeon folder.{'\n'}
            2. Put this phone on the same Wi-Fi as the computer.{'\n'}
            3. Check the address below (your computer's address, port {SERVER_PORT}).
          </Text>
          <TextInput
            style={styles.input}
            value={draftUrl}
            onChangeText={setDraftUrl}
            placeholder={`http://192.168.1.20:${SERVER_PORT}`}
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            onSubmitEditing={retry}
          />
          <Pressable style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]} onPress={retry}>
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={{ height: insets.bottom, backgroundColor: status === 'ready' ? colors.card : colors.bg }} />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  web: { flex: 1, backgroundColor: colors.bg },
  cover: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: colors.bg },
  mascots: { fontSize: 56 },
  title: { marginTop: 14, fontSize: 20, fontWeight: '800', color: colors.capy, textAlign: 'center' },
  spinner: { marginTop: 18 },
  help: { marginTop: 14, fontSize: 15, lineHeight: 23, color: colors.muted },
  code: { fontWeight: '800', color: colors.text },
  input: { alignSelf: 'stretch', marginTop: 18, height: 48, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.card, fontSize: 15, color: colors.text },
  button: { alignSelf: 'stretch', marginTop: 12, height: 50, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.matcha, borderBottomWidth: 4, borderBottomColor: colors.matchaDeep },
  buttonPressed: { borderBottomWidth: 0, transform: [{ translateY: 4 }] },
  buttonText: { fontSize: 16, fontWeight: '800', color: '#ffffff' },
});
