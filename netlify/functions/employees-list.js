const supabaseAdmin = require('../../../supabase/supabaseAdmin')

exports.handler = async function (event, context) {
  try {
    const { data, error } = await supabaseAdmin
      .from('employee')
      .select(
        `id, employee_number, department, position, status, business_id, name, birthday, email, phone_number, hire_date, retire_date, onboardings (id, status), offboardings (id, status)`
      )

    if (error) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: error.message }),
      }
    }

    const employees = data.map((emp) => ({
      id: emp.id,
      employeeNumber: emp.employee_number,
      department: emp.department,
      position: emp.position,
      status: emp.status,
      businessId: emp.business_id,
      name: emp.name,
      birthday: emp.birthday,
      email: emp.email,
      phoneNumber: emp.phone_number,
      hireDate: emp.hire_date,
      retireDate: emp.retire_date,
      onboardings: emp.onboardings,
      offboardings: emp.offboardings,
    }))

    return {
      statusCode: 200,
      body: JSON.stringify(employees),
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    }
  }
}
