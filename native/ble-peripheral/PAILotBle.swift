// PAILotBle — CoreBluetooth peripheral helper for the AIBroker hub.
// JSON lines on stdin/stdout (protocol: docs/ble-transport.md). stderr = log.
import Foundation
import CoreBluetooth

func emit(_ obj: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: obj),
          var s = String(data: d, encoding: .utf8) else { return }
    s += "\n"
    FileHandle.standardOutput.write(s.data(using: .utf8)!)
}
func elog(_ s: String) { FileHandle.standardError.write(("[ble-helper] " + s + "\n").data(using: .utf8)!) }

final class Peripheral: NSObject, CBPeripheralManagerDelegate {
    var mgr: CBPeripheralManager!
    var serviceUUID = CBUUID(string: "7A1F0001-3C5B-4D2E-9A41-5041494C4F54")
    let rxUUID = CBUUID(string: "7A1F0002-3C5B-4D2E-9A41-5041494C4F54")
    let txUUID = CBUUID(string: "7A1F0003-3C5B-4D2E-9A41-5041494C4F54")
    var name = "PAILot Hub"
    var wantStart = false
    var txChar: CBMutableCharacteristic?
    var central: CBCentral?
    var queue: [Data] = []

    override init() {
        super.init()
        mgr = CBPeripheralManager(delegate: self, queue: DispatchQueue.main)
    }

    func start(name: String, service: String) {
        self.name = name
        serviceUUID = CBUUID(string: service)
        wantStart = true
        if mgr.state == .poweredOn { setup() }
    }

    func setup() {
        guard wantStart else { return }
        mgr.stopAdvertising()
        mgr.removeAllServices()
        let rx = CBMutableCharacteristic(type: rxUUID, properties: [.write], value: nil, permissions: [.writeEncryptionRequired])
        let tx = CBMutableCharacteristic(type: txUUID, properties: [.notify], value: nil, permissions: [.readEncryptionRequired])
        txChar = tx
        let svc = CBMutableService(type: serviceUUID, primary: true)
        svc.characteristics = [rx, tx]
        mgr.add(svc)
    }

    func advertise() {
        mgr.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [serviceUUID], CBAdvertisementDataLocalNameKey: name])
    }

    func drop() {
        // CoreBluetooth cannot disconnect a central; rebuilding the service invalidates its subscription.
        central = nil
        queue.removeAll()
        emit(["ev": "central", "connected": false, "id": ""])
        setup()
    }

    func flush() {
        guard let tx = txChar, let c = central else { return }
        while let first = queue.first {
            if mgr.updateValue(first, for: tx, onSubscribedCentrals: [c]) { queue.removeFirst() } else { return }
        }
    }

    func peripheralManagerDidUpdateState(_ p: CBPeripheralManager) {
        elog("state=\(p.state.rawValue)")
        switch p.state {
        case .poweredOn: emit(["ev": "ready"]); setup()
        case .unauthorized: emit(["ev": "error", "msg": "bluetooth unauthorized (TCC denied)"])
        case .poweredOff: emit(["ev": "error", "msg": "bluetooth powered off"])
        case .unsupported: emit(["ev": "error", "msg": "bluetooth unsupported"])
        default: break
        }
    }

    func peripheralManager(_ p: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let e = error { emit(["ev": "error", "msg": "add service: \(e.localizedDescription)"]); return }
        advertise()
    }

    func peripheralManagerDidStartAdvertising(_ p: CBPeripheralManager, error: Error?) {
        if let e = error { emit(["ev": "error", "msg": "advertise: \(e.localizedDescription)"]); return }
        emit(["ev": "advertising", "name": name])
    }

    func peripheralManager(_ p: CBPeripheralManager, central c: CBCentral, didSubscribeTo ch: CBCharacteristic) {
        central = c // single central, newest wins
        queue.removeAll()
        emit(["ev": "central", "connected": true, "id": c.identifier.uuidString])
        emit(["ev": "mtu", "n": c.maximumUpdateValueLength])
    }

    func peripheralManager(_ p: CBPeripheralManager, central c: CBCentral, didUnsubscribeFrom ch: CBCharacteristic) {
        if central?.identifier == c.identifier {
            central = nil
            queue.removeAll()
            emit(["ev": "central", "connected": false, "id": c.identifier.uuidString])
        }
    }

    func peripheralManagerIsReady(toUpdateSubscribers p: CBPeripheralManager) { flush() }

    func peripheralManager(_ p: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for r in requests {
            if let v = r.value { emit(["ev": "rx", "b64": v.base64EncodedString()]) }
        }
        if let first = requests.first { p.respond(to: first, withResult: .success) }
    }

    func tx(_ d: Data) { queue.append(d); flush() }
}

let activity = ProcessInfo.processInfo.beginActivity(options: [.idleSystemSleepDisabled, .userInitiated], reason: "PAILot BLE link")
_ = activity
elog("bluetooth authorization=\(CBManager.authorization.rawValue) (0=undetermined 1=restricted 2=denied 3=allowed)")
let peripheral = Peripheral()

DispatchQueue.global().async {
    while let line = readLine() {
        guard let d = line.data(using: .utf8),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let cmd = o["cmd"] as? String else { continue }
        DispatchQueue.main.async {
            switch cmd {
            case "start":
                peripheral.start(name: o["name"] as? String ?? "PAILot Hub",
                                 service: o["service"] as? String ?? "7A1F0001-3C5B-4D2E-9A41-5041494C4F54")
            case "tx":
                if let b = o["b64"] as? String, let data = Data(base64Encoded: b) { peripheral.tx(data) }
            case "drop": peripheral.drop()
            case "quit": exit(0)
            default: break
            }
        }
    }
    DispatchQueue.main.async { exit(0) } // stdin closed: hub gone
}
RunLoop.main.run()
