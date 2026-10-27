import Foundation
import Security

/// Holds the API token for one server origin.
public protocol CredentialStore: Sendable {
  func token(account: String) throws(CredentialStoreError) -> String?
  func save(_ token: String, account: String) throws(CredentialStoreError)
  /// Deleting an absent item succeeds.
  func delete(account: String) throws(CredentialStoreError)
}

/// A Keychain failure, carrying the `OSStatus` and never the token.
public struct CredentialStoreError: Error, Equatable, Sendable {
  public var status: OSStatus

  public init(status: OSStatus) {
    self.status = status
  }
}

/// The login Keychain's generic password item with service
/// `sh.kidus.agentdesk.mac` and the server origin as its account, readable
/// after first unlock and never synchronized (DEC-19(3); component-mac-app
/// §Server and credential). A different `ServerURL` names a different item,
/// so it starts signed out.
public struct KeychainCredentialStore: CredentialStore {
  public static let service = "sh.kidus.agentdesk.mac"

  public init() {}

  /// The attributes that identify the item for one account.
  static func query(account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: kCFBooleanFalse!,
    ]
  }

  /// The attributes a newly written item carries besides its identity.
  static func attributes(token: String) -> [String: Any] {
    [
      kSecValueData as String: Data(token.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
    ]
  }

  public func token(account: String) throws(CredentialStoreError) -> String? {
    var query = Self.query(account: account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw CredentialStoreError(status: status)
    }
    return String(data: data, encoding: .utf8)
  }

  public func save(_ token: String, account: String) throws(CredentialStoreError) {
    let query = Self.query(account: account)
    let attributes = Self.attributes(token: token)
    let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if update == errSecSuccess { return }
    guard update == errSecItemNotFound else { throw CredentialStoreError(status: update) }
    let add = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
    guard add == errSecSuccess else { throw CredentialStoreError(status: add) }
  }

  public func delete(account: String) throws(CredentialStoreError) {
    let status = SecItemDelete(Self.query(account: account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw CredentialStoreError(status: status)
    }
  }
}
