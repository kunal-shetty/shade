import React from 'react';
import { Text } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { DarkTheme, DefaultTheme } from '@react-navigation/native';
import { useColorScheme } from 'react-native';
import { navDark, navLight, palette, useTheme, getThemeColors, ThemeContext } from '../theme/theme';
import { useLiveData } from '../store/rover';
import { useSettings } from '../store/settings';
import { DashboardScreen } from '../screens/DashboardScreen';
import { ControlScreen } from '../screens/ControlScreen';
import { CameraScreen } from '../screens/CameraScreen';
import { IncidentsScreen } from '../screens/IncidentsScreen';
import { IncidentDetailScreen } from '../screens/IncidentDetailScreen';
import { ThreatCenterScreen } from '../screens/ThreatCenterScreen';
import { ZoneMapScreen } from '../screens/ZoneMapScreen';
import { SettingsScreen } from '../screens/SettingsScreen';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const icon = (glyph: string) =>
  function TabIcon({ color, size }: { color: string; size: number }) {
    return <Text style={{ fontSize: size, color, lineHeight: size + 2 }}>{glyph}</Text>;
  };

const HomeIcon = icon('⌂');
const ControlIcon = icon('🕹');
const CameraIcon = icon('📷');
const IncidentsIcon = icon('🔔');
const SettingsIcon = icon('⚙');

const TabNavigator = () => {
  const c = useTheme();
  const unread = useLiveData((s) => s.lastIncidentId);
  const incidents = useLiveData((s) => s.incidents);

  // unread = open incidents newer than last time user visited Incidents tab
  const openCount = incidents.filter((i) => i.status === 'open').length;
  const showBadge = unread != null && openCount > 0;

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.primary,
        tabBarInactiveTintColor: c.textMuted,
        tabBarStyle: { backgroundColor: c.tabBar, borderTopColor: c.border },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
      }}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} options={{ tabBarIcon: HomeIcon, title: 'Home' }} />
      <Tab.Screen name="Control" component={ControlScreen} options={{ tabBarIcon: ControlIcon }} />
      <Tab.Screen name="Camera" component={CameraScreen} options={{ tabBarIcon: CameraIcon }} />
      <Tab.Screen
        name="Incidents"
        component={IncidentsScreen}
        options={{
          tabBarIcon: IncidentsIcon,
          tabBarBadge: showBadge ? openCount : undefined,
          tabBarBadgeStyle: { backgroundColor: palette.threatCritical, color: 'white' },
        }}
      />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarIcon: SettingsIcon }} />
    </Tab.Navigator>
  );
};

export const RootNavigator = () => {
  const scheme = useColorScheme();
  const darkMode = useSettings((s) => s.prefs.darkMode);
  const dark = darkMode === 'dark' || (darkMode === 'system' && scheme === 'dark');
  const colors = getThemeColors(dark);

  return (
    <ThemeContext.Provider value={colors}>
      <NavigationContainer theme={dark ? navDark : navLight}>
        <Stack.Navigator>
          <Stack.Screen name="Main" component={TabNavigator} options={{ headerShown: false }} />
          <Stack.Screen name="ThreatCenter" component={ThreatCenterScreen} options={{ headerBackTitle: 'Back' }} />
          <Stack.Screen name="ZoneMap" component={ZoneMapScreen} options={{ headerBackTitle: 'Back' }} />
          <Stack.Screen name="IncidentDetail" component={IncidentDetailScreen} options={{ headerBackTitle: 'Back' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </ThemeContext.Provider>
  );
};
