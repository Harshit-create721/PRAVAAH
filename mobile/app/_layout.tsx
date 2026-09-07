import { useEffect } from 'react';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { SairaCondensed_600SemiBold } from '@expo-google-fonts/saira-condensed/600SemiBold';
import { IBMPlexSans_400Regular } from '@expo-google-fonts/ibm-plex-sans/400Regular';
import { IBMPlexSans_500Medium } from '@expo-google-fonts/ibm-plex-sans/500Medium';
import { IBMPlexSans_600SemiBold } from '@expo-google-fonts/ibm-plex-sans/600SemiBold';
import { ActivityIndicator, Platform, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { bootstrap } from '../src/store/useRelay';
import { TickProvider } from '../src/ui/hooks';
import { colors } from '../src/ui/theme';

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({ SairaCondensed_600SemiBold, IBMPlexSans_400Regular, IBMPlexSans_500Medium, IBMPlexSans_600SemiBold });
  useEffect(() => { void bootstrap(); }, []);
  useEffect(() => {
    if (Platform.OS === 'web' || (!fontsLoaded && !fontError)) return;
    const notifications = require('expo-notifications') as typeof import('expo-notifications');
    const open = (response: import('expo-notifications').NotificationResponse) => {
      const id = response.notification.request.content.data?.alarmId;
      if (typeof id === 'number') router.push({ pathname: '/alarm/[id]', params: { id: String(id) } });
    };
    const sub = notifications.addNotificationResponseReceivedListener(open);
    void notifications.getLastNotificationResponseAsync().then(response => {
      if (response) { open(response); void notifications.clearLastNotificationResponseAsync(); }
    });
    return () => sub.remove();
  }, [fontsLoaded, fontError]);
  if (!fontsLoaded && !fontError) return <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 16 }}><ActivityIndicator color={colors.amber} /><Text style={{ color: colors.text }}>PRAVAAH</Text></View>;
  return <SafeAreaProvider><TickProvider><StatusBar style="light" /><Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'slide_from_right' }}>
    <Stack.Screen name="(tabs)" /><Stack.Screen name="connect" options={{ presentation: 'modal' }} /><Stack.Screen name="alarm/[id]" />
  </Stack></TickProvider></SafeAreaProvider>;
}
