import ExpoModulesCore

/// The JavaScript side of the action windows. `begin` adopts the window the
/// delegate began for a response, or begins one when the delegate saw none,
/// and returns `{ id, state }`; a pair that is not an AgentDesk answer action
/// returns null. `finish` ends a window by id. `onExpire` reports a window
/// that iOS expired.
public final class NotificationActionBackgroundModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NotificationActionBackground")

    Events("onExpire")

    // The newest module, for example after a reload, installs the expiry
    // handler. It holds the module weakly.
    OnCreate {
      DispatchQueue.main.async { [weak self] in
        MainActor.assumeIsolated {
          ActionWindows.shared.onExpire = { id in
            self?.sendEvent("onExpire", ["id": id])
          }
        }
      }
    }

    AsyncFunction("begin") { (requestId: String, actionId: String, categoryId: String) -> [String: Any]? in
      guard isAnswerAction(categoryId: categoryId, actionId: actionId) else {
        return nil
      }
      let window = MainActor.assumeIsolated {
        ActionWindows.shared.begin(requestId: requestId, actionId: actionId)
      }
      return window.asRecord
    }.runOnQueue(.main)

    AsyncFunction("finish") { (id: String) in
      MainActor.assumeIsolated {
        ActionWindows.shared.finish(id: id)
      }
    }.runOnQueue(.main)
  }
}
