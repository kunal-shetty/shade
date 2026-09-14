import React, { useEffect, useState } from 'react';
import { StatusBar, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation/RootNavigator';
import { RfidModal } from './src/components/RfidModal';
import { ConnectionBanner } from './src/components/ui';
import { getThemeColors, ThemeContext } from './src/theme/theme';
import { useSettings } from './src/store/settings';
import { useLiveData } from './src/store/rover';
import { connectMqtt, disconnectMqtt } from './src/services/mqtt';
import { connectRoverLink, disconnectRoverLink } from './src/services/roverLink';
import { startDemoEngine, stopDemoEngine } from './src/services/demoEngine';
import { registerPushToken } from './src/services/notifications';

export default function App() {
  const scheme = useColorScheme();
  const darkMode = useSettings((s) => s.prefs.darkMode);
  const demoMode = useSettings((s) => s.connection.demoMode);
  const mqttState = useLiveData((s) => s.mqttState);
  const dark = darkMode === 'dark' || (darkMode === 'system' && scheme === 'dark');
  const colors = getThemeColors(dark);

  const [servicesReady, setServicesReady] = useState(false);

  useEffect(() => {
    // connect after settings rehydrate from AsyncStorage
    const t = setTimeout(() => setServicesReady(true), 400);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!servicesReady) return;
    if (demoMode) {
      startDemoEngine();
    } else {
      connectMqtt();
      connectRoverLink();
    }
    if (!demoMode) void registerPushToken();
    return () => {
      stopDemoEngine();
      disconnectMqtt();
      disconnectRoverLink();
    };
  }, [servicesReady, demoMode]);

  const bannerState = demoMode ? 'demo' : mqttState;

  return (
    <SafeAreaProvider>
      <ThemeContext.Provider value={colors}>
        <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <ConnectionBanner state={bannerState} onRetry={() => { disconnectMqtt(); connectMqtt(); }} />
          <RootNavigator />
        </View>
        <RfidModal />
      </ThemeContext.Provider>
    </SafeAreaProvider>
  );
}
