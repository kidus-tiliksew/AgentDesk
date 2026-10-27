import Foundation

public enum LoginItemStatus: Equatable, Sendable {
  case enabled
  case notRegistered
  case requiresApproval
  case notFound
}

/// The system's login item registration for the app. The app target adapts
/// `SMAppService.mainApp` to it.
@MainActor
public protocol LoginItemService {
  var status: LoginItemStatus { get }
  func register() throws
  func unregister() throws
}

/// Open at Login (component-mac-app §Open at login). The first successful
/// sign-in turns it on; later sign-ins leave the user's choice alone
/// (req-mac-app AC-8.2).
@MainActor
public final class LoginItems {
  /// Set once the first-sign-in default has been applied.
  public static let defaultedKey = "OpenAtLoginDefaulted"

  private let service: LoginItemService
  private let defaults: UserDefaults
  /// The last registration failure, for the menu to report.
  public private(set) var lastError: String?

  public init(service: LoginItemService, defaults: UserDefaults) {
    self.service = service
    self.defaults = defaults
  }

  /// True when the system reports the app registered, including registered
  /// but waiting for the user's approval in System Settings.
  public var isOn: Bool {
    service.status == .enabled || service.status == .requiresApproval
  }

  public var status: LoginItemStatus { service.status }

  /// Turns Open at Login on after the first successful sign-in. A failed
  /// registration is retried at the next sign-in.
  public func didSignIn() {
    guard !defaults.bool(forKey: Self.defaultedKey) else { return }
    if apply(true) {
      defaults.set(true, forKey: Self.defaultedKey)
    }
  }

  /// The menu's toggle.
  public func set(_ on: Bool) {
    _ = apply(on)
  }

  private func apply(_ on: Bool) -> Bool {
    do {
      if on {
        try service.register()
      } else {
        try service.unregister()
      }
      lastError = nil
      return true
    } catch {
      lastError =
        on
        ? "Couldn't turn on Open at Login: \(error.localizedDescription)"
        : "Couldn't turn off Open at Login: \(error.localizedDescription)"
      return false
    }
  }
}
