platform :ios, '15.0'
use_frameworks!

target 'Frotz' do
    pod 'ObjectiveDropboxOfficial'
end

# Xcode 26 and later refuse deployment targets below iOS 15.0. The Dropbox pod still declares
# 11.0, so lift every pod target to the app's own minimum.
post_install do |installer|
    installer.pods_project.targets.each do |t|
        t.build_configurations.each do |config|
            config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
        end
    end
end
