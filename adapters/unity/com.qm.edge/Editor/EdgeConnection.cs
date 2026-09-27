using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace QmEdge.Editor
{
    public enum EdgeTransportEventKind
    {
        Opened,
        Message,
        Closed
    }

    public struct EdgeTransportEvent
    {
        public EdgeTransportEventKind Kind;
        public string Text;

        public EdgeTransportEvent(EdgeTransportEventKind kind, string text)
        {
            Kind = kind;
            Text = text;
        }
    }

    public sealed class EdgeConnection
    {
        const int ReceiveBufferBytes = 16 * 1024;
        const long MaxMessageBytes = 64L * 1024 * 1024;
        static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(10);
        static readonly TimeSpan KeepaliveInterval = TimeSpan.FromSeconds(10);
        static readonly TimeSpan SilenceLimit = TimeSpan.FromSeconds(30);
        static readonly TimeSpan SendWakeInterval = TimeSpan.FromSeconds(1);
        static readonly TimeSpan SendTimeout = TimeSpan.FromSeconds(10);
        static readonly TimeSpan WatchdogInterval = TimeSpan.FromSeconds(1);

        readonly Uri uri;
        readonly string keepaliveMessage;
        readonly ClientWebSocket socket = new ClientWebSocket();
        readonly CancellationTokenSource cancellation = new CancellationTokenSource();
        readonly ConcurrentQueue<EdgeTransportEvent> inbound = new ConcurrentQueue<EdgeTransportEvent>();
        readonly ConcurrentQueue<string> outbound = new ConcurrentQueue<string>();
        readonly SemaphoreSlim outboundSignal = new SemaphoreSlim(0);
        long lastReceivedTicks;
        int started;
        int closed;

        public EdgeConnection(Uri uri, string keepaliveMessage)
        {
            this.uri = uri;
            this.keepaliveMessage = keepaliveMessage;
            lastReceivedTicks = DateTime.UtcNow.Ticks;
        }

        public void Start()
        {
            if (Interlocked.Exchange(ref started, 1) != 0) return;
            Task.Run(() => RunAsync());
        }

        public void Send(string text)
        {
            if (text == null || Volatile.Read(ref closed) != 0) return;
            outbound.Enqueue(text);
            outboundSignal.Release();
        }

        public bool TryDequeue(out EdgeTransportEvent transportEvent)
        {
            return inbound.TryDequeue(out transportEvent);
        }

        public void Close()
        {
            if (Interlocked.Exchange(ref closed, 1) != 0) return;
            StopSocket();
        }

        async Task RunAsync()
        {
            string reason = "disconnected";
            try
            {
                using (var connectLimit = CancellationTokenSource.CreateLinkedTokenSource(cancellation.Token))
                {
                    connectLimit.CancelAfter(ConnectTimeout);
                    await socket.ConnectAsync(uri, connectLimit.Token).ConfigureAwait(false);
                }
                MarkReceived();
                inbound.Enqueue(new EdgeTransportEvent(EdgeTransportEventKind.Opened, null));
                Task<string> receiving = ReceiveLoopAsync();
                Task<string> sending = SendLoopAsync();
                Task<string> watching = WatchdogLoopAsync();
                Task<string> finished = await Task.WhenAny(receiving, sending, watching).ConfigureAwait(false);
                reason = finished.Result;
            }
            catch (OperationCanceledException)
            {
                reason = cancellation.IsCancellationRequested ? "disconnected" : "timed out connecting to " + uri;
            }
            catch (Exception exception)
            {
                reason = cancellation.IsCancellationRequested ? "disconnected" : Describe(exception);
            }
            finally
            {
                StopSocket();
                try
                {
                    socket.Dispose();
                }
                catch (Exception)
                {
                }
                inbound.Enqueue(new EdgeTransportEvent(EdgeTransportEventKind.Closed, reason));
            }
        }

        async Task<string> ReceiveLoopAsync()
        {
            CancellationToken token = cancellation.Token;
            var buffer = new byte[ReceiveBufferBytes];
            var message = new MemoryStream();
            try
            {
                while (!token.IsCancellationRequested)
                {
                    WebSocketReceiveResult result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), token).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        string description = result.CloseStatusDescription;
                        return string.IsNullOrEmpty(description) ? "hub closed the connection" : "hub closed the connection: " + description;
                    }
                    MarkReceived();
                    message.Write(buffer, 0, result.Count);
                    if (message.Length > MaxMessageBytes) return "hub message exceeded " + MaxMessageBytes + " bytes";
                    if (!result.EndOfMessage) continue;
                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        string text = Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
                        inbound.Enqueue(new EdgeTransportEvent(EdgeTransportEventKind.Message, text));
                    }
                    message.SetLength(0);
                }
                return "disconnected";
            }
            catch (OperationCanceledException)
            {
                return "disconnected";
            }
            catch (Exception exception)
            {
                return token.IsCancellationRequested ? "disconnected" : Describe(exception);
            }
        }

        async Task<string> SendLoopAsync()
        {
            CancellationToken token = cancellation.Token;
            DateTime lastKeepalive = DateTime.UtcNow;
            try
            {
                while (!token.IsCancellationRequested)
                {
                    await outboundSignal.WaitAsync(SendWakeInterval, token).ConfigureAwait(false);
                    string text;
                    while (outbound.TryDequeue(out text))
                    {
                        await SendTextAsync(text, token).ConfigureAwait(false);
                    }
                    DateTime now = DateTime.UtcNow;
                    if (now - lastKeepalive >= KeepaliveInterval)
                    {
                        lastKeepalive = now;
                        await SendTextAsync(keepaliveMessage, token).ConfigureAwait(false);
                    }
                }
                return "disconnected";
            }
            catch (OperationCanceledException)
            {
                return token.IsCancellationRequested ? "disconnected" : "timed out sending to the hub";
            }
            catch (Exception exception)
            {
                return token.IsCancellationRequested ? "disconnected" : Describe(exception);
            }
        }

        async Task<string> WatchdogLoopAsync()
        {
            CancellationToken token = cancellation.Token;
            try
            {
                while (!token.IsCancellationRequested)
                {
                    await Task.Delay(WatchdogInterval, token).ConfigureAwait(false);
                    DateTime lastReceived = new DateTime(Interlocked.Read(ref lastReceivedTicks), DateTimeKind.Utc);
                    if (DateTime.UtcNow - lastReceived > SilenceLimit) return "no message from the hub for 30 seconds";
                }
                return "disconnected";
            }
            catch (OperationCanceledException)
            {
                return "disconnected";
            }
        }

        async Task SendTextAsync(string text, CancellationToken token)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            using (var limit = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                limit.CancelAfter(SendTimeout);
                await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, limit.Token).ConfigureAwait(false);
            }
        }

        void MarkReceived()
        {
            Interlocked.Exchange(ref lastReceivedTicks, DateTime.UtcNow.Ticks);
        }

        void StopSocket()
        {
            try
            {
                cancellation.Cancel();
            }
            catch (Exception)
            {
            }
            try
            {
                socket.Abort();
            }
            catch (Exception)
            {
            }
        }

        static string Describe(Exception exception)
        {
            Exception root = exception.GetBaseException();
            if (root == null || root == exception || string.IsNullOrEmpty(root.Message)) return exception.Message;
            if (string.IsNullOrEmpty(exception.Message) || exception.Message == root.Message) return root.Message;
            return exception.Message + ": " + root.Message;
        }
    }
}
