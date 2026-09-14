import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { palette, spacing, typography, useTheme } from '../theme/theme';
import { useLiveData } from '../store/rover';
import { IncidentRow } from '../components/ui';
import { api } from '../services/api';
import type { Incident, Severity } from '../types';

const SEVERITY_FILTERS: (Severity | 'all')[] = ['all', 'critical', 'high', 'medium', 'low'];

const FILTER_ICONS: Record<Severity | 'all', keyof typeof Ionicons.glyphMap> = {
  all: 'apps',
  critical: 'alert',
  high: 'alert-circle',
  medium: 'warning',
  low: 'information-circle',
};

export const IncidentsScreen = ({ navigation }: any) => {
  const c = useTheme();
  const incidents = useLiveData((s) => s.incidents);
  const setIncidents = useLiveData((s) => s.setIncidents);
  const markSeen = useLiveData((s) => s.markSeen);
  const [severity, setSeverity] = useState<Severity | 'all'>('all');
  const [hideResolved, setHideResolved] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // Clear unread badge when user views the timeline (PRD §6.4.1)
  useEffect(() => {
    markSeen();
  }, [markSeen]);

  const load = useCallback(async () => {
    try {
      const list = await api.listIncidents({ limit: 50 });
      setIncidents(list);
      setLoadError(false);
    } catch {
      setLoadError(true); // demo mode / offline: keep whatever we have
    }
  }, [setIncidents]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const filtered = incidents.filter(
    (i: Incident) => (severity === 'all' || i.severity === severity) && (!hideResolved || i.status === 'open'),
  );
  const openCount = filtered.filter((i) => i.status === 'open').length;

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <View style={styles.headerRow}>
        <View>
          <Text style={[typography.caption, { color: c.textMuted, letterSpacing: 1.2 }]}>SECURITY LOG</Text>
          <Text style={[typography.h1, { color: c.text, fontSize: 26 }]}>Incidents</Text>
        </View>
        <View style={[styles.countChip, { backgroundColor: openCount > 0 ? `${palette.threatCritical}14` : `${palette.threatLow}14` }]}>
          <Ionicons name={openCount > 0 ? 'alert' : 'checkmark-circle'} size={13} color={openCount > 0 ? palette.threatCritical : palette.threatLow} />
          <Text style={{ color: openCount > 0 ? palette.threatCritical : palette.threatLow, fontSize: 11, fontWeight: '800' }}>
            {openCount} OPEN
          </Text>
        </View>
      </View>

      <View style={styles.filtersRow}>
        <FlatList
          horizontal
          data={SEVERITY_FILTERS}
          keyExtractor={(s) => s}
          showsHorizontalScrollIndicator={false}
          renderItem={({ item }) => {
            const active = severity === item;
            return (
              <View
                style={[styles.chip, { backgroundColor: active ? c.primary : c.surface, borderColor: active ? c.primary : c.border }]}
              >
                <Text onPress={() => setSeverity(item)} style={[styles.chipText, { color: active ? 'white' : c.textMuted }]} accessibilityRole="button" accessibilityLabel={'Filter ' + item}>
                  {item.toUpperCase()}
                </Text>
                <Ionicons name={FILTER_ICONS[item]} size={11} color={active ? 'white' : c.textMuted} />
              </View>
            );
          }}
          style={{ flexGrow: 0 }}
        />
        <View
          style={[styles.chip, { backgroundColor: hideResolved ? palette.threatLow : c.surface, borderColor: hideResolved ? palette.threatLow : c.border }]}
        >
          <Text
            onPress={() => setHideResolved((v) => !v)}
            style={[styles.chipText, { color: hideResolved ? 'white' : c.textMuted }]}
            accessibilityRole="button"
            accessibilityLabel="Toggle hide resolved"
          >
            {hideResolved ? 'OPEN ONLY' : 'ALL STATUS'}
          </Text>
          <Ionicons name="filter" size={11} color={hideResolved ? 'white' : c.textMuted} />
        </View>
      </View>

      {loadError && incidents.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="cloud-offline" size={40} color={c.textMuted} />
          <Text style={[typography.body, { color: c.textMuted, textAlign: 'center', marginTop: spacing.md }]}>
            No incident backend reachable.{'\n'}Enable Demo Mode in Settings to simulate incidents.
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(i) => String(i.id)}
          renderItem={({ item }) => (
            <IncidentRow incident={item} onPress={() => navigation.navigate('IncidentDetail', { id: item.id })} />
          )}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="checkmark-done-circle" size={40} color={palette.threatLow} />
              <Text style={[typography.body, { color: c.textMuted, marginTop: spacing.md }]}>No incidents match the current filters.</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  countChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  filtersRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999, borderWidth: 1, marginRight: spacing.sm },
  chipText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  list: { padding: spacing.lg, paddingTop: 0 },
  empty: { padding: spacing.xl, alignItems: 'center' },
});
