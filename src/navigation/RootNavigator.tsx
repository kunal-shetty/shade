import React from 'react';
import { Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
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

type IconName = keyof typeof Ionicons.glyphMap;

const tabIcon = (name: IconName, activeName: IconName) =>
  function TabIcon({ color, focused }: { color: string; focused: boolean; size: number }) {
    return <Ionicons name={focused ? activeName : name} size={21} color={color} />;
  };

const HomeIcon = tabIcon('home-outline', 'home');
const ControlIcon = tabIcon('game-controller-outline', 'game-controller');
const CameraIcon = tabIcon('videocam-outline', 'videocam');
const IncidentsIcon = tabIcon('notifications-outline', 'notifications');
const SettingsIcon = tabIcon('settings-outline', 'settings');

const TabNavigator = () => {
  const c = useTheme();
  const incidents = useLiveData((s) => s.incidents);
  const lastIncidentId = useLiveData((s) => s.lastIncidentId);

  const openCount = incidents.filter((i) => i.status === 'open').length;
  const showBadge = lastIncidentId != null && openCount > 0;

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.primary,
        tabBarInactiveTintColor: c.textMuted,
        tabBarStyle: { backgroundColor: c.tabBar, borderTopColor: c.border, height: 62, paddingBottom: 8, paddingTop: 6 },
        tabBarLabelStyle: { fontSize: 10, fontWeight: '700', letterSpacing: 0.2 },
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
          tabBarBadgeStyle: { backgroundColor: palette.threatCritical, color: 'white', fontSize: 10, fontWeight: '800' },
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
        <Stack.Navigator
          screenOptions={{
            headerBackTitle: 'Back',
            headerTintColor: colors.primary,
            headerTitleStyle: { fontWeight: '700', fontSize: 17 },
          }}
        >
          <Stack.Screen name="Main" component={TabNavigator} options={{ headerShown: false }} />
          <Stack.Screen name="ThreatCenter" component={ThreatCenterScreen} options={{ title: 'Threat Center' }} />
          <Stack.Screen name="ZoneMap" component={ZoneMapScreen} options={{ title: 'Zone Map' }} />
          <Stack.Screen name="IncidentDetail" component={IncidentDetailScreen} options={{ title: 'Incident Detail' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </ThemeContext.Provider>
  );
};
