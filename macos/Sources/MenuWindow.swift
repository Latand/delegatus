import Foundation

/// Chooses the window to capture while a menu is tracking, from a window-list
/// snapshot (`CGWindowListCopyWindowInfo` rows, keyed by the `kCGWindow…`
/// names). Only a window this process owns, at or above the pop-up menu level,
/// qualifies: the app's own menu bar strip sits below that level and another
/// process's window is never captured. A refusal names the guard that failed.
enum MenuWindowLookup: Equatable {
    case found(Int)
    case refused(String)

    static func select(_ rows: [[String: Any]], ownerPID: Int, menuLevel: Int) -> MenuWindowLookup {
        let owned = rows.filter { ($0["kCGWindowOwnerPID"] as? Int) == ownerPID }
        let others = rows.filter { ($0["kCGWindowOwnerPID"] as? Int) != ownerPID && ($0["kCGWindowLayer"] as? Int ?? Int.min) >= menuLevel }
            .map { ($0["kCGWindowOwnerName"] as? String) ?? "unnamed" }
        let foreign = others.isEmpty ? "" : "; menu-level windows of other processes: \(others.joined(separator: ","))"
        guard !owned.isEmpty else { return .refused("owner: no on-screen window owned by this process" + foreign) }
        let menus = owned.filter { ($0["kCGWindowLayer"] as? Int ?? Int.min) >= menuLevel }
        guard !menus.isEmpty else {
            let layers = owned.map { row in (row["kCGWindowLayer"] as? Int).map { String($0) } ?? "unknown" }.joined(separator: ",")
            return .refused("layer: no owned window at menu level \(menuLevel), owned layers \(layers)" + foreign)
        }
        var best: (layer: Int, number: Int)? = nil
        for row in menus {
            guard let number = row["kCGWindowNumber"] as? Int, let layer = row["kCGWindowLayer"] as? Int else { continue }
            if best == nil || layer > best!.layer { best = (layer, number) }
        }
        guard let best else { return .refused("number: the owned menu-level window has no window number") }
        return .found(best.number)
    }
}
