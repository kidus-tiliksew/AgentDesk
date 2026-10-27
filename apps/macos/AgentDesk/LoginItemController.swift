import AgentDeskKit
import ServiceManagement

/// Adapts `SMAppService.mainApp` to `LoginItemService` (component-mac-app
/// §Open at login).
@MainActor
struct MainAppLoginItem: LoginItemService {
  var status: LoginItemStatus {
    switch SMAppService.mainApp.status {
    case .enabled: .enabled
    case .requiresApproval: .requiresApproval
    case .notFound: .notFound
    case .notRegistered: .notRegistered
    @unknown default: .notRegistered
    }
  }

  func register() throws {
    try SMAppService.mainApp.register()
  }

  func unregister() throws {
    try SMAppService.mainApp.unregister()
  }
}
