export default function ConfigurationErrorPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-6">
      <div className="max-w-md rounded-lg bg-white p-8 text-center shadow-lg">
        <h1 className="mb-4 text-2xl font-bold text-gray-900">
          System Configuration Error
        </h1>
        <p className="mb-6 text-gray-600">
          The application is not properly configured. Please contact support.
        </p>
        <p className="text-sm text-gray-500">
          Error code: AUTH_CONFIG_MISSING
        </p>
      </div>
    </div>
  );
}
