# component-mobile-app §Notifications: the iOS background time for a
# notification action button. Expo autolinking finds this local module under
# apps/mobile/modules, and prebuild adds the pod to the generated project.
Pod::Spec.new do |s|
  s.name           = 'NotificationActionBackground'
  s.version        = '1.0.0'
  s.summary        = 'Background time for AgentDesk notification actions'
  s.description    = 'Holds a UIApplication background task while JavaScript answers a decision from a notification action button.'
  s.author         = 'AgentDesk'
  s.homepage       = 'https://github.com/kidus-tiliksew/AgentDesk'
  s.license        = 'MIT'
  s.platforms      = { :ios => '17.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'ExpoNotifications'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = '**/*.swift'
end
