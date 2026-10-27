import Foundation

/// The answer the user is composing in an expanded row: the chosen option or
/// options, the typed text, and the optional note (component-mac-app §Rows;
/// req-mac-app AC-4.6, AC-4.7). The row's controls bind to it, and Send and
/// ⌘↩ both read `submission`, so the answer the app sends is the one the
/// controls show.
public struct AnswerDraft: Equatable, Sendable {
  /// The longest note the server accepts, counted as it counts, in UTF-16
  /// code units (req-decision-requests AC-2.5).
  public static let noteLimit = 2000
  /// The longest text answer `spec/schemas/decision.schema.json` allows.
  public static let textLimit = 4000

  public let inputType: Decision.InputType
  public let options: [Option]
  public let recommendation: Answer?

  /// The chosen option of a single-choice or single-choice-or-text decision.
  /// Choosing one clears `text`.
  public var selectedOption: String? {
    didSet {
      if selectedOption != nil, inputType == .singleChoiceOrText { text = "" }
    }
  }
  /// The chosen options of a multiple-choice decision.
  public var selectedOptions: Set<String>
  /// The typed answer of a free-text decision, or the alternative of a
  /// single-choice-or-text decision. Typing an alternative clears
  /// `selectedOption`.
  public var text: String {
    didSet {
      if !text.isEmpty, inputType == .singleChoiceOrText { selectedOption = nil }
    }
  }
  public var isNoteOpen = false
  public var note = ""

  /// A draft with the recommendation preselected (AC-4.6).
  public init(decision: Decision) {
    inputType = decision.inputType
    options = decision.options ?? []
    recommendation = decision.recommendation
    selectedOptions = []
    text = ""
    switch decision.recommendation {
    case .option(let id)? where inputType == .singleChoice || inputType == .singleChoiceOrText:
      selectedOption = id
    case .options(let ids)? where inputType == .multipleChoice:
      selectedOptions = Set(ids)
    default:
      break
    }
  }

  // MARK: Presentation

  /// Whether the option is part of the recommendation, so the row labels it
  /// "Suggested".
  public func isSuggested(_ optionID: String) -> Bool {
    switch recommendation {
    case .option(let id)?: id == optionID
    case .options(let ids)?: ids.contains(optionID)
    default: false
    }
  }

  /// The recommended text, which the text field shows as its placeholder.
  public var suggestedText: String? {
    if case .text(let text)? = recommendation { return text }
    return nil
  }

  /// Whether the button for `answer` carries the recommendation, for
  /// approve-or-reject rows (AC-4.5).
  public func isSuggested(_ answer: Answer) -> Bool { recommendation == answer }

  // MARK: Answer

  /// The answer the controls hold, or nil when nothing valid is chosen.
  /// Invalid input never falls back to the recommendation: an alternative of
  /// only spaces or an over-long text yields nil.
  public var chosenAnswer: Answer? {
    switch inputType {
    case .approveReject:
      return nil
    case .singleChoice:
      return selectedOption.flatMap(option)
    case .multipleChoice:
      let ids = options.map(\.id).filter(selectedOptions.contains)
      return ids.isEmpty ? nil : .options(ids: ids)
    case .freeText:
      return typedText.map(Answer.text)
    case .singleChoiceOrText:
      if let selectedOption { return option(selectedOption) }
      return typedText.map(Answer.text)
    }
  }

  /// The answer Send and ⌘↩ submit: the chosen answer, or the
  /// recommendation when the user chose nothing (req-mac-app AC-7.1). Nil
  /// when neither exists, when the input is invalid, or when the note is too
  /// long.
  public var submission: Submission? {
    guard noteIsValid else { return nil }
    if let chosenAnswer { return Submission(answer: chosenAnswer, note: submittedNote) }
    guard choseNothing, let recommendation else { return nil }
    return Submission(answer: recommendation, note: submittedNote)
  }

  /// A button answer of an approve-or-reject decision with this draft's
  /// note, or nil when the note is too long.
  public func submission(for answer: Answer) -> Submission? {
    guard noteIsValid else { return nil }
    return Submission(answer: answer, note: submittedNote)
  }

  public var canSend: Bool { submission != nil }

  /// The note as sent: nil when the field is closed or blank.
  public var submittedNote: String? {
    guard isNoteOpen else { return nil }
    let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  public var noteIsValid: Bool { (submittedNote?.utf16.count ?? 0) <= Self.noteLimit }

  /// True when the user has not chosen or typed anything, so the
  /// recommendation stands in. A multiple-choice draft whose preselection the
  /// user cleared, or a text field of only spaces, is a choice of nothing
  /// valid, not an absence of choice.
  private var choseNothing: Bool {
    switch inputType {
    case .approveReject: true
    case .singleChoice: selectedOption == nil
    case .multipleChoice: selectedOptions.isEmpty && !recommendationIsMultiple
    case .freeText, .singleChoiceOrText: selectedOption == nil && text.isEmpty
    }
  }

  /// A multiple-choice draft starts with the recommendation selected, so an
  /// empty selection means the user cleared it.
  private var recommendationIsMultiple: Bool {
    if case .options? = recommendation { return true }
    return false
  }

  private var typedText: String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.utf16.count <= Self.textLimit else { return nil }
    return trimmed
  }

  private func option(_ id: String) -> Answer? {
    options.contains(where: { $0.id == id }) ? .option(id: id) : nil
  }

  /// An answer with its optional note, ready to post.
  public struct Submission: Equatable, Sendable {
    public var answer: Answer
    public var note: String?

    public init(answer: Answer, note: String? = nil) {
      self.answer = answer
      self.note = note
    }
  }
}
