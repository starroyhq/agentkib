import 'dart:convert';
import 'dart:io';

import '../generated/remote_protocol.g.dart';

Map<String, Object?> fixture(String name) =>
    jsonDecode(
          File.fromUri(
            Platform.script.resolve('fixtures/$name.json'),
          ).readAsStringSync(),
        )
        as Map<String, Object?>;

void main() {
  final negotiation = fixture('session-state-negotiation');
  final hosts = negotiation['hosts'] as Map<String, Object?>;
  final cases = negotiation['cases'] as List<Object?>;
  final states = fixture('session-state');

  for (final entry in cases.cast<Map<String, Object?>>()) {
    final access = hosts[entry['host']] as Map<String, Object?>;
    final stateSample = entry['stateSample'];
    final sample = states[stateSample] as Map<String, Object?>?;
    final live = sample?['live'] as Map<String, Object?>?;
    final value = stateSample == null ? entry['state'] : live!['state'];
    final result = negotiateSessionState(
      access,
      entry['provider'] as String,
      value,
    );
    if (result.kind.name != entry['expected'] ||
        (result.state != null) !=
            (result.kind == SessionStateNegotiationKind.v1)) {
      throw StateError(
        '${entry['name']}: expected ${entry['expected']}, got ${result.kind}',
      );
    }
  }
  stdout.writeln('${cases.length} session-state negotiation cases passed');
}
