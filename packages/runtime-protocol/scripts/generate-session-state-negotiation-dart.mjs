export function sessionStateNegotiationDart({ capability, providerCoverage }, version) {
  return `enum SessionStateNegotiationKind { legacy, unavailable, v1 }

/// Negotiate from the authorized access scope and the selected session's own Provider.
({SessionStateNegotiationKind kind, SessionState? state}) negotiateSessionState(
  Map<String, Object?> access,
  String provider,
  Object? value,
) {
  if (access[${JSON.stringify(capability)}] != ${version}) {
    return (kind: SessionStateNegotiationKind.legacy, state: null);
  }
  final covered = access[${JSON.stringify(providerCoverage)}];
  if (covered is! List<Object?> ||
      covered.any((key) => key is! String || key.isEmpty || key.trim() != key) ||
      covered.toSet().length != covered.length) {
    return (kind: SessionStateNegotiationKind.unavailable, state: null);
  }
  if (!covered.contains(provider)) {
    return (kind: SessionStateNegotiationKind.legacy, state: null);
  }
  final state = SessionState.tryParse(value);
  return state == null
      ? (kind: SessionStateNegotiationKind.unavailable, state: null)
      : (kind: SessionStateNegotiationKind.v1, state: state);
}`;
}
