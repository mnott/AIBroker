// PAILotP2p — MultipeerConnectivity advertiser helper for the AIBroker hub.
// JSON lines on stdin/stdout (protocol: docs/p2p-transport.md). stderr = log.
// argv[1] = display name (default "PAILot Hub").
import Foundation
import MultipeerConnectivity

func emit(_ obj: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: obj),
          var s = String(data: d, encoding: .utf8) else { return }
    s += "\n"
    FileHandle.standardOutput.write(s.data(using: .utf8)!)
}
func elog(_ s: String) { FileHandle.standardError.write(("[p2p-helper] " + s + "\n").data(using: .utf8)!) }

final class Hub: NSObject, MCSessionDelegate, MCNearbyServiceAdvertiserDelegate {
    let name: String
    let me: MCPeerID
    let session: MCSession
    let advertiser: MCNearbyServiceAdvertiser
    var peers: [String: MCPeerID] = [:]

    init(name: String) {
        self.name = name
        me = MCPeerID(displayName: name)
        session = MCSession(peer: me, securityIdentity: nil, encryptionPreference: .required)
        advertiser = MCNearbyServiceAdvertiser(peer: me, discoveryInfo: ["v": "2"], serviceType: "pailot-p2p")
        super.init()
        session.delegate = self
        advertiser.delegate = self
    }

    func start() { advertiser.startAdvertisingPeer(); emit(["ev": "advertising", "name": name]) }

    func id(_ p: MCPeerID) -> String { "\(p.displayName)#\(p.hash)" }

    // Accept every invitation; the application layer authenticates (hub drops unauthenticated peers).
    func advertiser(_ a: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID,
                    withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        invitationHandler(true, session)
    }

    func advertiser(_ a: MCNearbyServiceAdvertiser, didNotStartAdvertisingPeer error: Error) {
        emit(["ev": "error", "msg": "advertise: \(error.localizedDescription)"])
    }

    func session(_ s: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        let pid = id(peerID)
        switch state {
        case .connected:
            peers[pid] = peerID
            emit(["ev": "peer", "id": pid, "name": peerID.displayName, "state": "connected"])
        case .notConnected:
            if peers.removeValue(forKey: pid) != nil {
                emit(["ev": "peer", "id": pid, "name": peerID.displayName, "state": "disconnected"])
            }
        default: break
        }
    }

    func session(_ s: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        emit(["ev": "data", "peer": id(peerID), "b64": data.base64EncodedString()])
    }
    func session(_ s: MCSession, didReceive stream: InputStream, withName: String, fromPeer: MCPeerID) {}
    func session(_ s: MCSession, didStartReceivingResourceWithName: String, fromPeer: MCPeerID, with: Progress) {}
    func session(_ s: MCSession, didFinishReceivingResourceWithName: String, fromPeer: MCPeerID, at: URL?, withError: Error?) {}

    func send(peer: String, data: Data) {
        guard let p = peers[peer] else { return }
        do { try session.send(data, toPeers: [p], with: .reliable) }
        catch { emit(["ev": "error", "msg": "send: \(error.localizedDescription)"]) }
    }

    func disconnect(peer: String) {
        // MC cannot kick a single peer; cancel the session (all peers reconnect and re-authenticate).
        if peers[peer] != nil { session.disconnect() }
    }
}

let activity = ProcessInfo.processInfo.beginActivity(options: [.idleSystemSleepDisabled, .userInitiated], reason: "PAILot P2P link")
_ = activity
let hub = Hub(name: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "PAILot Hub")
emit(["ev": "ready"])
hub.start()

DispatchQueue.global().async {
    while let line = readLine() {
        guard let d = line.data(using: .utf8),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let cmd = o["cmd"] as? String else { continue }
        DispatchQueue.main.async {
            switch cmd {
            case "send":
                if let p = o["peer"] as? String, let b = o["b64"] as? String, let data = Data(base64Encoded: b) { hub.send(peer: p, data: data) }
            case "disconnect": if let p = o["peer"] as? String { hub.disconnect(peer: p) }
            case "stop": exit(0)
            default: break
            }
        }
    }
    DispatchQueue.main.async { exit(0) } // stdin closed: hub gone
}
RunLoop.main.run()
