using System.Collections.Generic;
using System.Globalization;
using UnityEditor;
using UnityEngine;

namespace QmEdge.Editor
{
    public sealed class QmEdgeWindow : EditorWindow
    {
        const string Separator = " — ";

        string hubUrl;
        string projectId;
        string displayName;
        string actorId;
        string token;
        Vector2 peersScroll;
        Vector2 eventsScroll;
        GUIStyle statusStyle;

        [MenuItem("Window/QM Edge")]
        public static void Open()
        {
            QmEdgeWindow window = GetWindow<QmEdgeWindow>();
            window.titleContent = new GUIContent("QM Edge");
            window.Show();
        }

        void OnEnable()
        {
            titleContent = new GUIContent("QM Edge");
            LoadFields();
            EdgeBootstrap.Session.Changed += Repaint;
        }

        void OnDisable()
        {
            EdgeBootstrap.Session.Changed -= Repaint;
        }

        void OnGUI()
        {
            EdgeSession session = EdgeBootstrap.Session;
            DrawSettings(session);
            EditorGUILayout.Space();
            DrawStatus(session);
            EditorGUILayout.Space();
            DrawPeers(session);
            EditorGUILayout.Space();
            DrawEvents(session);
        }

        void DrawSettings(EdgeSession session)
        {
            EditorGUILayout.LabelField("Hub", EditorStyles.boldLabel);
            using (new EditorGUI.DisabledScope(session.WantsConnection))
            {
                EditorGUI.BeginChangeCheck();
                hubUrl = EditorGUILayout.TextField("Hub URL", hubUrl);
                projectId = EditorGUILayout.TextField("Project ID", projectId);
                displayName = EditorGUILayout.TextField("Display name", displayName);
                actorId = EditorGUILayout.TextField("Actor ID", actorId);
                token = EditorGUILayout.PasswordField("Join token", token);
                if (EditorGUI.EndChangeCheck()) SaveFields();
            }
            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.FlexibleSpace();
                if (!session.WantsConnection)
                {
                    if (GUILayout.Button("Connect", GUILayout.Width(120)))
                    {
                        SaveFields();
                        session.Connect();
                    }
                }
                else if (GUILayout.Button("Disconnect", GUILayout.Width(120)))
                {
                    session.Disconnect();
                    LoadFields();
                }
            }
        }

        void DrawStatus(EdgeSession session)
        {
            if (statusStyle == null) statusStyle = new GUIStyle(EditorStyles.boldLabel) { fontSize = 18 };
            EdgeConnectionState state = session.State;
            string label;
            Color color;
            switch (state)
            {
                case EdgeConnectionState.Connected:
                    label = "CONNECTED";
                    color = new Color(0.2f, 0.7f, 0.3f);
                    break;
                case EdgeConnectionState.Connecting:
                    label = "CONNECTING";
                    color = new Color(0.9f, 0.6f, 0.1f);
                    break;
                default:
                    label = "DISCONNECTED";
                    color = new Color(0.6f, 0.6f, 0.6f);
                    break;
            }
            statusStyle.normal.textColor = color;
            GUILayout.Label(label, statusStyle, GUILayout.Height(28));
            if (state == EdgeConnectionState.Connected)
            {
                string hub = string.IsNullOrEmpty(session.HubName) ? "hub" : session.HubName;
                EditorGUILayout.LabelField(hub + Separator + session.ProjectId + Separator + "sequence #" + session.LastAppliedSequence.ToString(CultureInfo.InvariantCulture), EditorStyles.miniLabel);
            }
            if (!string.IsNullOrEmpty(session.LastError)) EditorGUILayout.HelpBox(session.LastError, MessageType.Warning);
        }

        void DrawPeers(EdgeSession session)
        {
            EditorGUILayout.LabelField("Peers", EditorStyles.boldLabel);
            IReadOnlyList<EdgeMember> members = session.Members;
            if (members.Count == 0)
            {
                EditorGUILayout.LabelField("No peers yet", EditorStyles.miniLabel);
                return;
            }
            peersScroll = EditorGUILayout.BeginScrollView(peersScroll, GUILayout.MinHeight(60), GUILayout.MaxHeight(160));
            foreach (EdgeMember member in members) GUILayout.Label(DescribeMember(member, session.NodeId), EditorStyles.label);
            EditorGUILayout.EndScrollView();
        }

        void DrawEvents(EdgeSession session)
        {
            EditorGUILayout.LabelField("Recent events", EditorStyles.boldLabel);
            IReadOnlyList<EdgeEventEntry> events = session.Events;
            if (events.Count == 0)
            {
                EditorGUILayout.LabelField("No events yet", EditorStyles.miniLabel);
                return;
            }
            eventsScroll = EditorGUILayout.BeginScrollView(eventsScroll);
            foreach (EdgeEventEntry entry in events) GUILayout.Label(DescribeEvent(entry), EditorStyles.label);
            EditorGUILayout.EndScrollView();
        }

        static string DescribeMember(EdgeMember member, string ownNodeId)
        {
            var parts = new List<string>
            {
                !string.IsNullOrEmpty(member.DisplayName) ? member.DisplayName : member.ActorId,
                !string.IsNullOrEmpty(member.ActorType) ? member.ActorType : "unknown"
            };
            string adapterLabel = AdapterLabel(member.Adapter);
            if (adapterLabel != null) parts.Add(adapterLabel);
            parts.Add(!string.IsNullOrEmpty(member.Status) ? member.Status : "offline");
            string line = string.Join(Separator, parts);
            if (!string.IsNullOrEmpty(member.WorkingOnLabel)) line += Separator + "working on " + member.WorkingOnLabel;
            if (ownNodeId != null && member.NodeId == ownNodeId) line += " (you)";
            return line;
        }

        static string DescribeEvent(EdgeEventEntry entry)
        {
            string line = "#" + entry.Sequence.ToString(CultureInfo.InvariantCulture) + " " + entry.ActorName + " " + entry.Text;
            if (entry.Count > 1) line += " (x" + entry.Count.ToString(CultureInfo.InvariantCulture) + ")";
            return line;
        }

        static string AdapterLabel(string adapter)
        {
            if (string.IsNullOrEmpty(adapter)) return null;
            if (adapter == UnityEdgeAdapter.AdapterName) return "Unity";
            return char.ToUpperInvariant(adapter[0]) + adapter.Substring(1);
        }

        void LoadFields()
        {
            hubUrl = EdgePrefs.HubUrl;
            projectId = EdgePrefs.ProjectId;
            displayName = EdgePrefs.DisplayName;
            actorId = EdgePrefs.ActorId;
            token = EdgePrefs.Token;
        }

        void SaveFields()
        {
            EdgePrefs.HubUrl = hubUrl;
            EdgePrefs.ProjectId = projectId;
            EdgePrefs.DisplayName = displayName;
            EdgePrefs.ActorId = actorId;
            EdgePrefs.Token = token;
        }
    }
}
