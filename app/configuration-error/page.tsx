export default function ConfigurationErrorPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-6">
      <div className="max-w-md rounded-lg bg-white p-8 text-center shadow-lg">
        <h1 className="mb-4 text-2xl font-bold text-gray-900">
          Sign-in is not set up
        </h1>
        <p className="mb-6 text-gray-600">
          Sign-in has not been set up for this app. Contact support to get it working.
        </p>
        <p className="text-sm text-gray-500">
          Error code: AUTH_CONFIG_MISSING
        </p>
      </div>
    </div>
  );
}
