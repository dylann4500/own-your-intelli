using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;

namespace QmEdge.Editor
{
    public enum EdgeConnectionState
    {
        Disconnected,
        Connecting,
        Connected
    }

    public sealed class EdgeSession
    {
        public const int ProtocolVersion = 1;
        const int MaxEvents = 50;
        const int MaxRecentSent = 2048;
        const int MaxSubmitsPerSecond = 60;
        const int MaxAnnouncedResources = 2000;
        const int AnnounceChunkSize = 250;
        const int MaxMessagesPerUpdate = 500;
        const double PresenceInterval = 0.25;
        static readonly double[] ReconnectDelays = { 1, 2, 5, 10 };
        static readonly Regex ProjectIdPattern = new Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\\z");

        sealed class InflightOperation
        {
            public string Id;
            public string ResourceType;
            public string ResourceId;
            public string Effect;
            public List<string> Keys;
        }

        readonly IEdgeAdapter adapter;
        readonly Dictionary<string, string> pendingByKey = new Dictionary<string, string>();
        readonly Dictionary<string, string> pendingCreates = new Dictionary<string, string>();
        readonly Dictionary<string, InflightOperation> inflight = new Dictionary<string, InflightOperation>();
        readonly List<InflightOperation> lost = new List<InflightOperation>();
        readonly HashSet<string> recentSent = new HashSet<string>();
        readonly Queue<string> recentSentOrder = new Queue<string>();
        readonly List<EdgeMember> members = new List<EdgeMember>();
        readonly List<EdgeEventEntry> events = new List<EdgeEventEntry>();

        EdgeSettings settings;
        EdgeConnection transport;
        bool wantConnected;
        bool joined;
        bool localStateTrusted;
        bool lastPlaying;
        int reconnectAttempt;
        double reconnectAt = -1;
        long lastAppliedSequence;
        long newestEventSequence;
        double submitWindowStart = double.NegativeInfinity;
        int submitWindowCount;
        bool presenceDirty;
        Dictionary<string, object> desiredWorkingOn;
        double lastPresenceSentAt = double.NegativeInfinity;

        public EdgeSession(IEdgeAdapter adapter)
        {
            if (adapter == null) throw new ArgumentNullException(nameof(adapter));
            this.adapter = adapter;
            lastPlaying = EditorApplication.isPlayingOrWillChangePlaymode;
            adapter.Attach(this);
        }

        public event Action Changed;

        public string LastError { get; private set; }

        public string HubName { get; private set; }

        public bool IsJoined
        {
            get { return joined; }
        }

        public bool WantsConnection
        {
            get { return wantConnected; }
        }

        public string NodeId
        {
            get { return settings != null ? settings.NodeId : null; }
        }

        public string ProjectId
        {
            get { return settings != null ? settings.ProjectId : null; }
        }

        public long LastAppliedSequence
        {
            get { return lastAppliedSequence; }
        }

        public IReadOnlyList<EdgeMember> Members
        {
            get { return members; }
        }

        public IReadOnlyList<EdgeEventEntry> Events
        {
            get { return events; }
        }

        public EdgeConnectionState State
        {
            get
            {
                if (joined) return EdgeConnectionState.Connected;
                if (transport != null || (wantConnected && reconnectAt >= 0)) return EdgeConnectionState.Connecting;
                return EdgeConnectionState.Disconnected;
            }
        }

        public void Connect()
        {
            wantConnected = true;
            EdgePrefs.AutoConnect = true;
            reconnectAttempt = 0;
            LastError = null;
            OpenTransport();
        }

        public void Disconnect()
        {
            wantConnected = false;
            EdgePrefs.AutoConnect = false;
            reconnectAt = -1;
            CloseTransport();
            NotifyChanged();
        }

        public void Shutdown()
        {
            CloseTransport();
            adapter.Detach();
        }

        public void Update()
        {
            double now = EditorApplication.timeSinceStartup;
            bool playing = EditorApplication.isPlayingOrWillChangePlaymode;
            bool enteredEditMode = lastPlaying && !playing;
            lastPlaying = playing;
            if (enteredEditMode) OnEnteredEditMode();
            DrainTransport();
            if (transport == null && wantConnected && reconnectAt >= 0 && now >= reconnectAt) OpenTransport();
            if (joined && !playing) FlushPresence(now);
            adapter.Tick();
        }

        public void RequestResync()
        {
            localStateTrusted = false;
            if (!joined || EditorApplication.isPlayingOrWillChangePlaymode) return;
            SendJoin();
        }

        public void SetWorkingOn(string resourceType, string resourceId, string label)
        {
            Dictionary<string, object> value = null;
            if (EdgeText.IsValidId(resourceId))
            {
                value = new Dictionary<string, object>();
                if (!string.IsNullOrEmpty(resourceType)) value["resourceType"] = resourceType;
                value["resourceId"] = resourceId;
                string cleaned = EdgeText.Clean(label, 120);
                if (cleaned != null) value["label"] = cleaned;
            }
            if (SameWorkingOn(desiredWorkingOn, value)) return;
            desiredWorkingOn = value;
            presenceDirty = true;
        }

        public bool TrySubmit(string resourceType, string resourceId, string action, string effect, Dictionary<string, object> payload, string label)
        {
            if (!joined || transport == null || settings == null || EditorApplication.isPlayingOrWillChangePlaymode) return false;
            if (!EdgeText.IsValidId(resourceId)) return true;
            double now = EditorApplication.timeSinceStartup;
            if (now - submitWindowStart >= 1.0)
            {
                submitWindowStart = now;
                submitWindowCount = 0;
            }
            if (submitWindowCount >= MaxSubmitsPerSecond) return false;
            submitWindowCount++;
            var operation = new EdgeOperation
            {
                Id = Guid.NewGuid().ToString(),
                ProjectId = settings.ProjectId,
                ActorId = settings.ActorId,
                NodeId = settings.NodeId,
                Adapter = adapter.AdapterId,
                ResourceType = resourceType,
                ResourceId = resourceId,
                Action = action,
                Effect = effect,
                Payload = payload ?? new Dictionary<string, object>(),
                Label = EdgeText.Clean(label, 160),
                ClientTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            };
            Send(new Dictionary<string, object>
            {
                { "type", "submitOperation" },
                { "operation", operation.ToSubmission(ProtocolVersion) }
            });
            RememberSent(operation.Id);
            inflight[operation.Id] = new InflightOperation
            {
                Id = operation.Id,
                ResourceType = resourceType,
                ResourceId = resourceId,
                Effect = effect,
                Keys = new List<string>(operation.Payload.Keys)
            };
            if (effect != EdgeEffect.Delete)
            {
                foreach (string key in operation.Payload.Keys) pendingByKey[PendingKey(resourceId, key)] = operation.Id;
            }
            if (effect == EdgeEffect.Create) pendingCreates[resourceId] = operation.Id;
            return true;
        }

        void OpenTransport()
        {
            CloseTransport();
            reconnectAt = -1;
            EdgeSettings next = EdgePrefs.Load();
            Uri uri;
            string problem = Validate(next, out uri);
            if (problem != null)
            {
                LastError = problem;
                wantConnected = false;
                EdgePrefs.AutoConnect = false;
                Debug.LogWarning("[QM Edge] " + problem);
                NotifyChanged();
                return;
            }
            if (settings == null || settings.ProjectId != next.ProjectId || settings.HubUrl != next.HubUrl)
            {
                lastAppliedSequence = 0;
                localStateTrusted = false;
                newestEventSequence = 0;
                events.Clear();
                lost.Clear();
            }
            settings = next;
            string keepalive = Json.Serialize(new Dictionary<string, object> { { "type", "ping" } });
            transport = new EdgeConnection(uri, keepalive);
            transport.Start();
            NotifyChanged();
        }

        void CloseTransport()
        {
            if (transport != null)
            {
                transport.Close();
                transport = null;
            }
            joined = false;
            members.Clear();
            foreach (InflightOperation operation in inflight.Values) lost.Add(operation);
            inflight.Clear();
            ClearAllPending();
        }

        static string Validate(EdgeSettings candidate, out Uri uri)
        {
            uri = null;
            if (string.IsNullOrEmpty(candidate.HubUrl) || !Uri.TryCreate(candidate.HubUrl, UriKind.Absolute, out uri) || (uri.Scheme != "ws" && uri.Scheme != "wss"))
            {
                return "Hub URL must be a ws:// or wss:// address such as " + EdgePrefs.DefaultHubUrl;
            }
            if (string.IsNullOrEmpty(candidate.ProjectId) || !ProjectIdPattern.IsMatch(candidate.ProjectId))
            {
                return "Project ID must be 1-64 letters, digits, '.', '_' or '-' and start with a letter or digit";
            }
            if (string.IsNullOrEmpty(candidate.ActorId)) return "Actor ID is required";
            if (string.IsNullOrEmpty(candidate.DisplayName)) return "Display name is required";
            if (candidate.Token != null && candidate.Token.Length > 256) return "Join token must be at most 256 characters";
            return null;
        }

        void DrainTransport()
        {
            int budget = MaxMessagesPerUpdate;
            EdgeTransportEvent transportEvent;
            while (budget-- > 0 && transport != null && transport.TryDequeue(out transportEvent))
            {
                switch (transportEvent.Kind)
                {
                    case EdgeTransportEventKind.Opened:
                        OnOpened();
                        break;
                    case EdgeTransportEventKind.Message:
                        OnMessage(transportEvent.Text);
                        break;
                    case EdgeTransportEventKind.Closed:
                        OnClosed(transportEvent.Text);
                        break;
                }
            }
        }

        void OnOpened()
        {
            var actor = new Dictionary<string, object>
            {
                { "id", settings.ActorId },
                { "displayName", settings.DisplayName },
                { "type", "human" }
            };
            var node = new Dictionary<string, object>
            {
                { "id", settings.NodeId },
                { "adapter", adapter.AdapterId }
            };
            if (!string.IsNullOrEmpty(settings.DeviceName)) node["deviceName"] = settings.DeviceName;
            Send(new Dictionary<string, object>
            {
                { "type", "hello" },
                { "protocolVersion", ProtocolVersion },
                { "actor", actor },
                { "node", node }
            });
            SendJoin();
            NotifyChanged();
        }

        void OnClosed(string reason)
        {
            bool wasJoined = joined;
            CloseTransport();
            if (wantConnected)
            {
                double delay = ReconnectDelays[Math.Min(reconnectAttempt, ReconnectDelays.Length - 1)];
                reconnectAttempt++;
                reconnectAt = EditorApplication.timeSinceStartup + delay;
                LastError = reason;
                if (wasJoined || reconnectAttempt == 1)
                {
                    Debug.LogWarning("[QM Edge] " + reason + "; reconnecting in " + delay.ToString(CultureInfo.InvariantCulture) + "s");
                }
            }
            NotifyChanged();
        }

        void OnEnteredEditMode()
        {
            if (!joined) return;
            adapter.BeginSync();
            SendJoin();
        }

        void SendJoin()
        {
            var message = new Dictionary<string, object>
            {
                { "type", "joinProject" },
                { "projectId", settings.ProjectId },
                { "token", settings.Token ?? "" }
            };
            if (lastAppliedSequence > 0) message["lastSequence"] = lastAppliedSequence;
            Send(message);
        }

        void OnMessage(string text)
        {
            Dictionary<string, object> message;
            try
            {
                message = Json.Parse(text) as Dictionary<string, object>;
            }
            catch (FormatException exception)
            {
                Debug.LogWarning("[QM Edge] ignored a malformed hub message: " + exception.Message);
                return;
            }
            if (message == null) return;
            try
            {
                Dispatch(message);
            }
            catch (Exception exception)
            {
                Debug.LogException(exception);
            }
            NotifyChanged();
        }

        void Dispatch(Dictionary<string, object> message)
        {
            switch (Json.GetString(message, "type"))
            {
                case "welcome":
                    HubName = Json.GetString(message, "hubName");
                    break;
                case "joined":
                    OnJoined(message);
                    break;
                case "presence":
                    if (Json.GetString(message, "projectId") == settings.ProjectId) ReplaceMembers(Json.GetArray(message, "members"));
                    break;
                case "committedOperation":
                    OnCommitted(Json.GetObject(message, "operation"));
                    break;
                case "operationAck":
                    ClearPending(Json.GetString(message, "operationId"));
                    break;
                case "eventHistory":
                    OnEventHistory(message);
                    break;
                case "error":
                    OnHubError(message);
                    break;
                case "left":
                    if (Json.GetString(message, "projectId") == settings.ProjectId) joined = false;
                    break;
            }
        }

        void OnJoined(Dictionary<string, object> message)
        {
            if (Json.GetString(message, "projectId") != settings.ProjectId) return;
            joined = true;
            reconnectAttempt = 0;
            LastError = null;
            ReplaceMembers(Json.GetArray(message, "members"));
            events.Clear();
            newestEventSequence = 0;
            var committedIds = new HashSet<string>();
            List<object> history = Json.GetArray(message, "history");
            if (history != null)
            {
                foreach (object item in history)
                {
                    EdgeOperation operation = EdgeOperation.FromJson(item as Dictionary<string, object>);
                    if (operation == null) continue;
                    committedIds.Add(operation.Id);
                    RecordEvent(operation);
                }
            }
            long latest = Json.GetLong(message, "latestSequence") ?? 0;
            if (EditorApplication.isPlayingOrWillChangePlaymode) return;
            long skipThrough = localStateTrusted && !adapter.ChangedWhileDetached ? lastAppliedSequence : 0;
            lastAppliedSequence = latest;
            localStateTrusted = true;
            adapter.BeginSync();
            var states = new Dictionary<string, EdgeResourceState>();
            var snapshot = new List<EdgeOperation>();
            List<object> resources = Json.GetArray(message, "resources");
            if (resources != null)
            {
                foreach (object item in resources)
                {
                    EdgeResourceState state = EdgeResourceState.FromJson(item as Dictionary<string, object>);
                    if (state == null || state.Adapter != adapter.AdapterId) continue;
                    states[StateKey(state.ResourceType, state.ResourceId)] = state;
                    AddSnapshotOperations(state, snapshot, skipThrough);
                }
            }
            snapshot.Sort(CompareSnapshotOperations);
            foreach (EdgeOperation operation in snapshot) Apply(operation, true);
            RecoverLost(states, committedIds, skipThrough);
            Announce();
            presenceDirty = true;
        }

        void AddSnapshotOperations(EdgeResourceState state, List<EdgeOperation> operations, long skipThrough)
        {
            if (state.LastSequence <= skipThrough) return;
            if (!state.Exists)
            {
                if (state.DeletedSequence.HasValue && state.DeletedSequence.Value > skipThrough) operations.Add(SnapshotOperation(state, EdgeEffect.Delete, state.DeletedSequence.Value, new Dictionary<string, object>()));
                return;
            }
            long created = state.CreatedSequence ?? 0;
            Dictionary<string, object> createPayload = created > 0 ? new Dictionary<string, object>() : null;
            var current = new Dictionary<string, object>();
            var updates = new SortedDictionary<long, Dictionary<string, object>>();
            foreach (KeyValuePair<string, object> property in state.Properties)
            {
                long version;
                if (!state.Versions.TryGetValue(property.Key, out version) || version <= 0) continue;
                current[property.Key] = property.Value;
                if (createPayload != null && version <= created)
                {
                    createPayload[property.Key] = property.Value;
                    continue;
                }
                Dictionary<string, object> group;
                if (!updates.TryGetValue(version, out group))
                {
                    group = new Dictionary<string, object>();
                    updates[version] = group;
                }
                group[property.Key] = property.Value;
            }
            if (createPayload != null && created > skipThrough)
            {
                EdgeOperation create = SnapshotOperation(state, EdgeEffect.Create, created, createPayload);
                create.ResourceProperties = current;
                operations.Add(create);
            }
            foreach (KeyValuePair<long, Dictionary<string, object>> update in updates)
            {
                if (update.Key <= skipThrough) continue;
                operations.Add(SnapshotOperation(state, EdgeEffect.Update, update.Key, update.Value));
            }
        }

        EdgeOperation SnapshotOperation(EdgeResourceState state, string effect, long sequence, Dictionary<string, object> payload)
        {
            return new EdgeOperation
            {
                Id = "snapshot",
                ProjectId = settings.ProjectId,
                Adapter = state.Adapter,
                ResourceType = state.ResourceType,
                ResourceId = state.ResourceId,
                Action = "snapshot",
                Effect = effect,
                Payload = payload,
                Sequence = sequence
            };
        }

        static int CompareSnapshotOperations(EdgeOperation left, EdgeOperation right)
        {
            int order = left.Sequence.CompareTo(right.Sequence);
            if (order != 0) return order;
            order = EffectRank(left.Effect).CompareTo(EffectRank(right.Effect));
            if (order != 0) return order;
            return string.CompareOrdinal(left.ResourceId, right.ResourceId);
        }

        static int EffectRank(string effect)
        {
            if (effect == EdgeEffect.Create) return 0;
            if (effect == EdgeEffect.Update) return 1;
            return 2;
        }

        void RecoverLost(Dictionary<string, EdgeResourceState> states, HashSet<string> committedIds, long skipThrough)
        {
            if (lost.Count == 0) return;
            var recovering = new List<InflightOperation>(lost);
            lost.Clear();
            foreach (InflightOperation operation in recovering)
            {
                if (committedIds.Contains(operation.Id)) continue;
                EdgeResourceState state;
                states.TryGetValue(StateKey(operation.ResourceType, operation.ResourceId), out state);
                if (operation.Effect == EdgeEffect.Create)
                {
                    if (state == null || (!state.CreatedSequence.HasValue && !state.DeletedSequence.HasValue)) Reject(operation, operation.Keys);
                    continue;
                }
                if (operation.Effect == EdgeEffect.Delete)
                {
                    if (state == null || state.Exists) Reject(operation, operation.Keys);
                    continue;
                }
                var missing = new List<string>();
                foreach (string key in operation.Keys)
                {
                    long version;
                    if (state == null || !state.Versions.TryGetValue(key, out version) || version <= skipThrough) missing.Add(key);
                }
                if (missing.Count > 0) Reject(operation, missing);
            }
        }

        void Reject(InflightOperation operation, IList<string> keys)
        {
            try
            {
                adapter.OnOperationRejected(operation.ResourceId, operation.Effect, keys);
            }
            catch (Exception exception)
            {
                Debug.LogException(exception);
            }
        }

        static string StateKey(string resourceType, string resourceId)
        {
            return resourceType + "\n" + resourceId;
        }

        void OnCommitted(Dictionary<string, object> map)
        {
            EdgeOperation operation = EdgeOperation.FromJson(map);
            if (operation == null || operation.ProjectId != settings.ProjectId) return;
            RecordEvent(operation);
            bool own = (settings.NodeId != null && operation.NodeId == settings.NodeId) || recentSent.Contains(operation.Id);
            if (own) ClearPending(operation.Id);
            if (!joined || operation.Sequence <= lastAppliedSequence) return;
            if (EditorApplication.isPlayingOrWillChangePlaymode) return;
            lastAppliedSequence = operation.Sequence;
            if (own || operation.Adapter != adapter.AdapterId) return;
            Apply(operation, false);
        }

        void OnEventHistory(Dictionary<string, object> message)
        {
            if (Json.GetString(message, "projectId") != settings.ProjectId) return;
            List<object> operations = Json.GetArray(message, "operations");
            if (operations == null) return;
            foreach (object item in operations) OnCommitted(item as Dictionary<string, object>);
        }

        void Apply(EdgeOperation operation, bool fromSnapshot)
        {
            if (operation.Effect == EdgeEffect.None) return;
            if (operation.Effect == EdgeEffect.Delete)
            {
                if (pendingCreates.ContainsKey(operation.ResourceId)) return;
            }
            else
            {
                var filtered = new Dictionary<string, object>();
                foreach (KeyValuePair<string, object> entry in operation.Payload)
                {
                    if (!pendingByKey.ContainsKey(PendingKey(operation.ResourceId, entry.Key))) filtered[entry.Key] = entry.Value;
                }
                if (operation.Effect == EdgeEffect.Update && filtered.Count == 0) return;
                operation.Payload = filtered;
            }
            try
            {
                adapter.ApplyRemote(operation, fromSnapshot);
            }
            catch (Exception exception)
            {
                Debug.LogException(exception);
            }
        }

        void OnHubError(Dictionary<string, object> message)
        {
            string code = Json.GetString(message, "code") ?? "error";
            string text = Json.GetString(message, "message") ?? "";
            string requestType = Json.GetString(message, "requestType");
            string operationId = Json.GetString(message, "operationId");
            LastError = code + ": " + text;
            Debug.LogWarning("[QM Edge] hub rejected " + (requestType ?? "a message") + " (" + code + "): " + text);
            InflightOperation rejected = null;
            if (operationId != null)
            {
                inflight.TryGetValue(operationId, out rejected);
                ClearPending(operationId);
            }
            if (rejected != null && code == "rate_limited") Reject(rejected, rejected.Keys);
            if (rejected != null && code == "not_joined") lost.Add(rejected);
            bool fatal = code == "unauthorized" || code == "unsupported_protocol_version" || requestType == "hello" || requestType == "joinProject";
            if (!fatal && code == "not_joined" && joined && transport != null)
            {
                joined = false;
                SendJoin();
            }
            if (!fatal) return;
            wantConnected = false;
            EdgePrefs.AutoConnect = false;
            reconnectAt = -1;
            CloseTransport();
        }

        void Announce()
        {
            var batch = new List<object>();
            int total = 0;
            foreach (EdgeAnnouncedResource resource in adapter.DescribeResources())
            {
                if (total >= MaxAnnouncedResources) break;
                if (resource == null || !EdgeText.IsValidId(resource.ResourceId)) continue;
                batch.Add(resource.ToJson());
                total++;
                if (batch.Count < AnnounceChunkSize) continue;
                SendAnnounce(batch);
                batch = new List<object>();
            }
            if (batch.Count > 0) SendAnnounce(batch);
        }

        void SendAnnounce(List<object> resources)
        {
            Send(new Dictionary<string, object>
            {
                { "type", "announceResources" },
                { "projectId", settings.ProjectId },
                { "adapter", adapter.AdapterId },
                { "resources", resources }
            });
        }

        void FlushPresence(double now)
        {
            if (!presenceDirty || now - lastPresenceSentAt < PresenceInterval) return;
            presenceDirty = false;
            lastPresenceSentAt = now;
            Send(new Dictionary<string, object>
            {
                { "type", "presence" },
                { "projectId", settings.ProjectId },
                { "workingOn", desiredWorkingOn }
            });
        }

        void ReplaceMembers(List<object> list)
        {
            members.Clear();
            if (list == null) return;
            foreach (object item in list)
            {
                EdgeMember member = EdgeMember.FromJson(item as Dictionary<string, object>);
                if (member != null) members.Add(member);
            }
        }

        void RecordEvent(EdgeOperation operation)
        {
            if (operation.Sequence <= newestEventSequence) return;
            newestEventSequence = operation.Sequence;
            string key = operation.ActorId + "\n" + operation.ResourceType + "\n" + operation.ResourceId + "\n" + operation.Action;
            string text = !string.IsNullOrEmpty(operation.Label) ? operation.Label : operation.Action + " " + operation.ResourceId;
            if (events.Count > 0 && events[0].CoalesceKey == key)
            {
                EdgeEventEntry latest = events[0];
                latest.Sequence = operation.Sequence;
                latest.Text = text;
                latest.Count++;
                return;
            }
            events.Insert(0, new EdgeEventEntry
            {
                Sequence = operation.Sequence,
                ActorId = operation.ActorId,
                ActorName = !string.IsNullOrEmpty(operation.ActorDisplayName) ? operation.ActorDisplayName : operation.ActorId,
                ResourceType = operation.ResourceType,
                ResourceId = operation.ResourceId,
                Action = operation.Action,
                Text = text,
                Count = 1,
                CoalesceKey = key
            });
            if (events.Count > MaxEvents) events.RemoveAt(events.Count - 1);
        }

        void RememberSent(string operationId)
        {
            if (!recentSent.Add(operationId)) return;
            recentSentOrder.Enqueue(operationId);
            while (recentSentOrder.Count > MaxRecentSent) recentSent.Remove(recentSentOrder.Dequeue());
        }

        void ClearPending(string operationId)
        {
            if (string.IsNullOrEmpty(operationId)) return;
            inflight.Remove(operationId);
            RemoveWhereValue(pendingByKey, operationId);
            RemoveWhereValue(pendingCreates, operationId);
        }

        void ClearAllPending()
        {
            pendingByKey.Clear();
            pendingCreates.Clear();
        }

        static void RemoveWhereValue(Dictionary<string, string> map, string value)
        {
            List<string> stale = null;
            foreach (KeyValuePair<string, string> entry in map)
            {
                if (entry.Value != value) continue;
                if (stale == null) stale = new List<string>();
                stale.Add(entry.Key);
            }
            if (stale == null) return;
            foreach (string key in stale) map.Remove(key);
        }

        static string PendingKey(string resourceId, string property)
        {
            return resourceId + "|" + property;
        }

        static bool SameWorkingOn(Dictionary<string, object> left, Dictionary<string, object> right)
        {
            if (left == null || right == null) return left == right;
            return Json.Serialize(left) == Json.Serialize(right);
        }

        void Send(Dictionary<string, object> message)
        {
            if (transport == null) return;
            transport.Send(Json.Serialize(message));
        }

        void NotifyChanged()
        {
            Action handler = Changed;
            if (handler != null) handler();
        }
    }
}
